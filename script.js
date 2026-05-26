const canvas = document.getElementById('simCanvas');
const ctx = canvas.getContext('2d');

const WIDTH = 2800;
const HEIGHT = 750;
const NUM_LOADER = 13;

const AMR_LANE_Y = 340;
const OUTPUT_LANE_Y = 370;
const DOCKING_Y = 250;
const PED_LANE_Y = 410;
const EXCLUSION_BUFFER = 200;

// ===== 스케일: 중앙통로 총길이 50m = 2100px =====
const CORRIDOR_START_X = 80;
const CORRIDOR_END_X   = 2180;
const CORRIDOR_PX      = CORRIDOR_END_X - CORRIDOR_START_X; // 2100px
const CORRIDOR_M       = 53;   // 53m (사용자 요청 거리)
const PX_PER_M         = CORRIDOR_PX / CORRIDOR_M; // 39.6 px/m

const INPUT_Y = 578; // AMR_LANE_Y(340) + 238(6m)
const OUTPUT_Y = 102; // AMR_LANE_Y(340) - 238(6m)

// MULTI INPUT ZONES
const INPUT_ZONES = {
    'M3 5X':    { entryX: 1697, exitX: 1667, y: INPUT_Y },
    'M3 UPPER': { entryX: 1757, exitX: 1727, y: INPUT_Y },
    'M3 2ND':   { entryX: 1817, exitX: 1787, y: INPUT_Y }
};

// CHARGE (오른쪽 전용 라인 및 베이)
const CHARGE_EXIT_X = 1880; // 출차 라인 (왼쪽)
const CHARGE_ENTRY_X = 1910; // 입차 라인 (오른쪽)
const CHARGE_BAY_X = 1980;   // 베이 X좌표
const CHARGE_EXIT_NODE = {x: CHARGE_EXIT_X, y: AMR_LANE_Y};
const CHARGE_ENTRY_NODE = {x: CHARGE_ENTRY_X, y: AMR_LANE_Y};

// MULTI OUTPUT ZONES
const OUTPUT_ZONES = {
    'M3 5X':    { entryX: 2500, exitX: 2530, y: OUTPUT_Y },
    'M3 UPPER': { entryX: 2560, exitX: 2590, y: OUTPUT_Y },
    'M3 2ND':   { entryX: 2620, exitX: 2650, y: OUTPUT_Y }
};

function getIO(type, model) {
    if(!model) model = 'M3 5X';
    return type === 'IN' ? INPUT_ZONES[model] : OUTPUT_ZONES[model];
}


let dual_lane = false;

// Generate siding gaps dynamically for 16 loaders + 1 extra at the end
// Generate siding gaps dynamically (between loaders)
let SIDING_GAP_ORDER = [];

function updateSidingOrder() {
    SIDING_GAP_ORDER = [];
    const gap = CORRIDOR_PX / (NUM_LOADER - 1);
    // 로더 사이의 간격 생성
    for(let i=0; i<NUM_LOADER-1; i++){
        SIDING_GAP_ORDER.push(80 + i * gap + gap/2);
    }
    // V40: 13호기 오른쪽으로 회피존 추가
    const lastLdrX = 80 + (NUM_LOADER - 1) * gap;
    SIDING_GAP_ORDER.push(lastLdrX + gap/2);
}
updateSidingOrder();

let extra_sidings = [];
let evade_mode = 'SIDING_ONLY'; // 기본: 회피존만 사용

function updateExtraSidings() {
    updateSidingOrder();
    extra_sidings = SIDING_GAP_ORDER.map(x => ({x: x, y: DOCKING_Y, type: 'EXTRA'}));
}
updateExtraSidings(); // 시작 시 즉시 초기화

function getEvadeCandidates(ldrs) {
    if (evade_mode === 'CNC_ONLY') return ldrs.map(l => l.x);
    if (evade_mode === 'SIDING_ONLY') return extra_sidings.map(s => s.x);
    return [...ldrs.map(l => l.x), ...extra_sidings.map(s => s.x)];
}

const COLOR_AMR_LANE = 'rgba(249,115,22,0.15)';
const COLOR_AMR_LINE = '#ea580c';
const COLOR_PED_LANE = '#e2e8f0';
const COLOR_AMR = ['#2563eb','#10b981','#8b5cf6','#eab308'];

const MODELS = [
    {name:'M3 5X',  ct:150},
    {name:'M3 UPPER',ct:150},
    {name:'M3 2ND', ct:125}
];

let global_production = {'M3 5X':0,'M3 UPPER':0,'M3 2ND':0};
let priority_mode = 'LOADED_YIELDS';
let eject_threshold = 8;
let use_pre_eject = false; // [변경] 초기값 비활성화
let time_scale = 1; // [변경] 초기 1배속
let is_paused = true;
let stats = { calls: 0, totalWait: 0 };
let evade_detect_range = 120;

// V35 핵심 로직: 배출칸수-1칸(CALLING) 및 배출칸수(DONE) 상태 로더가 후보
// 우선순위: DONE > CALLING > 피스(Pieces) 많은 순 > 대기시간 > 모델 밸런스
function getBestLoader(candidates) {
    if(!candidates || candidates.length === 0) return null;
    return [...candidates].sort((a, b) => {
        // 1. DONE 우선 (DONE=0, CALLING=1)
        const aS = a.status === 'DONE' ? 0 : 1;
        const bS = b.status === 'DONE' ? 0 : 1;
        if(aS !== bS) return aS - bS;
        
        // 2. 현재 트레이 수(trays)가 많은 로더 우선 (가장 긴급)
        if(b.trays !== a.trays) return b.trays - a.trays;
        
        // 3. 트레이 수가 같다면: 피스 수가 많은 로더 우선
        if(b.pieces !== a.pieces) return b.pieces - a.pieces;
        
        // 4. 모든 조건이 같다면: 오래 대기한 로더 우선
        return a.done_timestamp - b.done_timestamp;
    })[0];
}



function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return "00:00:00";
    let h = Math.floor(seconds / 3600);
    let m = Math.floor((seconds % 3600) / 60);
    let s = Math.floor(seconds % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function updateClocks() {
    if (!manager) return;
    let clockEl = document.getElementById('clock-env');
    if (clockEl) clockEl.innerText = formatTime(manager.global_time);

    // [NEW] 개별 로더 지연 시간 UI 업데이트
    ldrs.forEach((l, i) => {
        const waitEl = document.getElementById(`ldr-wait-${i}`);
        const waitBox = waitEl ? waitEl.parentElement : null;
        if (waitEl && waitBox) {
            waitEl.innerText = formatTime(l.cumulative_wait);
            // 가시성 개선: 대기 중일 때(DONE)와 아닐 때의 스타일 구분 강화
            if (l.status === 'DONE') {
                waitBox.style.background = '#ef4444'; // 진한 빨간색 배경
                waitBox.style.color = '#ffffff';       // 흰색 글자
                waitEl.style.color = '#ffffff';
            } else {
                waitBox.style.background = '#f1f5f9'; // 연한 회색 배경
                waitBox.style.color = '#64748b';       // 어두운 회색 글자
                waitEl.style.color = '#1e293b';
            }
        }
    });
}

function runAnalysis(sim_dt) {
    // 글로벌 대기시간 스톱워치: 하나라도 대기 중이면 증가
    let anyWaiting = ldrs.some(l => l.active && l.status === 'DONE' && !l.amr_assigned);
    if (anyWaiting && manager.speed > 0) {
        stats.totalWait += sim_dt;
    }
    
    // 물류 부하율 수식 고도화 (Active Load, Buffer, System Overhead, Reserved Load)
    let activeAmrsCount = amrs.length;
    let chargingAmrsCount = amrs.filter(a => a.state === 'CHARGING' || a.state === 'ENTERING_BAY' || a.state === 'TO_CHARGE_DOCK' || a.state === 'EXITING_BAY' || a.state === 'FROM_CHARGE_DOCK').length;
    
    // 공급 능력 (System Overhead 차감)
    let supplyCapacity = Math.max(0, activeAmrsCount - chargingAmrsCount); 
    
    // 실제 부하 (Active Load)
    let busyAmrsCount = amrs.filter(a => a.state !== 'WAITING_INPUT' && a.state !== 'CHARGING' && a.state !== 'ENTERING_BAY' && a.state !== 'TO_CHARGE_DOCK' && a.state !== 'EXITING_BAY' && a.state !== 'FROM_CHARGE_DOCK').length; 
    
    // 예약 부하 (Reserved Load)
    let pendingCalls = ldrs.filter(l => l.active && (l.status === 'CALLING' || l.status === 'DONE' || l.status === 'FINISHING') && !l.amr_assigned).length; 
    
    // 현재 수요 (Demand)
    let currentDemand = busyAmrsCount + pendingCalls;
    
    let loadFactor = 0;
    if (supplyCapacity === 0) {
        loadFactor = currentDemand > 0 ? 100 : 0;
    } else {
        loadFactor = Math.min(100, Math.round((currentDemand / supplyCapacity) * 100));
    }
    
    if (document.getElementById('val-load')) {
        document.getElementById('val-load').innerText = `${loadFactor}%`;
    }
    if (document.getElementById('val-wait')) {
        document.getElementById('val-wait').innerText = formatTime(stats.totalWait);
    }
    
    // AMR 배터리 UI 업데이트
    amrs.forEach((a, i) => {
        const bar = document.getElementById(`amr-bat-bar-${i}`);
        const text = document.getElementById(`amr-bat-text-${i}`);
        if(bar && text) {
            const pct = Math.max(0, Math.min(100, (a.battery / a.max_battery) * 100));
            bar.style.width = `${pct}%`;
            bar.style.backgroundColor = pct > 20 ? '#10b981' : '#ef4444';
            const h = Math.floor(a.battery / 3600);
            const m = Math.floor((a.battery % 3600) / 60);
            
            let statusText = "";
            if (a.state === 'CHARGING') statusText = " (충전중)";
            else if (a.state === 'TO_CHARGE_DOCK' || a.state === 'ENTERING_BAY') statusText = " (충전이동)";
            
            text.style.color = '#475569';
            text.style.fontWeight = 'normal';
            if (a.battery <= 0) {
                statusText = " (방전! 강제충전)";
                text.style.color = '#ef4444';
                text.style.fontWeight = 'bold';
                bar.style.backgroundColor = '#ef4444';
            }
            
            text.innerText = `${h}h ${m}m (${Math.round(pct)}%)${statusText}`;
        }
    });
    
    return loadFactor; // 부하율을 반환하여 AMR 판단에 사용
}

class SimulationManager {
    constructor(){ 
        this.speed=1; 
        this.global_time=0; 
        this.paused=true; // 초기 상태 일시정지
        this.mode = 'FORWARD'; // FORWARD, REVERSE
        this.history = []; // 상태 기록 배열
        this.maxHistory = 10000; // 최대 기록 수
        this.targetHours = 20; // [변경] 초기 20시간
    this.history = [];
    }
    update(sim_dt){
        if (this.paused) return;
        
        if (this.mode === 'FORWARD') {
            this.global_time += sim_dt;

            // [NEW] 목표 조업 시간 도달 시 자동 정지
            if (this.targetHours > 0 && this.global_time >= this.targetHours * 3600) {
                this.global_time = this.targetHours * 3600;
                this.paused = true;
                alert(`🎯 조업 목표 시간(${this.targetHours}시간)에 도달하여 시뮬레이션을 정지합니다.`);
                const btnPause = document.getElementById('btn-pause');
                if(btnPause) setActive('#btn-pause,#btn-start,#btn-backward', btnPause);
            }

            // 상태 기록
            this.captureState();
        } else {
            // REVERSE 모드
            this.rewind();
        }

        document.getElementById('prod-m3-5x').innerText   = global_production['M3 5X'].toLocaleString();
        document.getElementById('prod-m3-upper').innerText = global_production['M3 UPPER'].toLocaleString();
        document.getElementById('prod-m3-2nd').innerText  = global_production['M3 2ND'].toLocaleString();
    }

    captureState() {
        // 매 프레임의 핵심 상태를 스냅샷으로 저장
        const snapshot = {
            gt: this.global_time,
            stats: { calls: stats.calls, totalWait: stats.totalWait },
            prod: { ...global_production },
            ldrs: ldrs.map(l => ({
                s: l.status, t: l.trays, p: l.pieces, pc: l.production_count, et: l.elapsed_time, aa: l.amr_assigned, dt: l.done_timestamp
            })),
            amrs: amrs.map(a => ({
                x: a.pos.x, y: a.pos.y, s: a.state, tx: a.target_x, ty: a.target_y, pl: a.payload, pm: a.payload_model, pt: a.payload_type, bt: a.battery, tl: a.target_ldr ? a.target_ldr.id : null, et: a.evade_target, stx: a.saved_target_x, ss: a.saved_state, ns: a.next_state, wt: a.wait_timer
            }))
        };
        this.history.push(snapshot);
        if (this.history.length > this.maxHistory) this.history.shift();
    }

    rewind() {
        // 속도(배속)에 비례하여 히스토리에서 데이터를 꺼냄
        let steps = Math.max(1, Math.floor(this.speed));
        let lastSt = null;
        for (let i = 0; i < steps; i++) {
            if (this.history.length > 0) {
                lastSt = this.history.pop();
            }
        }
        if (lastSt) {
            this.applyState(lastSt);
        } else {
            // 더 이상 기록이 없으면 일시정지
            this.paused = true;
            this.mode = 'FORWARD';
            const btnPause = document.getElementById('btn-pause');
            if(btnPause) setActive('#btn-pause,#btn-start,#btn-backward', btnPause);
        }
    }

    applyState(st) {
        this.global_time = st.gt;
        stats.calls = st.stats.calls;
        stats.totalWait = st.stats.totalWait;
        global_production['M3 5X'] = st.prod['M3 5X'];
        global_production['M3 UPPER'] = st.prod['M3 UPPER'];
        global_production['M3 2ND'] = st.prod['M3 2ND'];

        st.ldrs.forEach((ls, i) => {
            let l = ldrs[i];
            l.status = ls.s; l.trays = ls.t; l.pieces = ls.p; l.production_count = ls.pc; l.elapsed_time = ls.et; l.amr_assigned = ls.aa; l.done_timestamp = ls.dt;
        });
        st.amrs.forEach((as, i) => {
            let a = amrs[i];
            a.pos.x = as.x; a.pos.y = as.y; a.state = as.s; a.target_x = as.tx; a.target_y = as.ty; a.payload = as.pl; a.payload_model = as.pm; a.payload_type = as.pt; a.battery = as.bt; 
            a.target_ldr = as.tl !== null ? ldrs[as.tl] : null;
            a.evade_target = as.et; a.saved_target_x = as.stx; a.saved_state = as.ss; a.next_state = as.ns; a.wait_timer = as.wt;
        });
    }
}

class Loader {
    constructor(id,x){
        this.id=id; this.x=x; this.y=170;
        this.status='RUNNING'; this.amr_assigned=false;
        this.elapsed_time=0; this.pieces=0; this.trays=1; // [변경] 트레이 1칸부터 시작
        this.production_count=0;
        this.finishing_timer = 0;
        if(id < 4) this.model = MODELS[0];      // 1~4: M3 5X
        else if(id < 10) this.model = MODELS[1]; // 5~10: M3 UPPER
        else this.model = MODELS[2];            // 11~13: M3 2ND
        this.targetTrays=8; this.pieces_per_tray=6;
        this.startTrays = 1; 
        this.preEjectTrays = 7; // [변경] 사전 배출 칸수 기본값 7
        this.active = true;
        this.cycleTime = this.model.ct;
        this.done_timestamp = 0;
        this.cumulative_wait = 0;
        this.wait_history = []; // [NEW] 대기 히스토리 기록
        this.current_wait_event = null; // [NEW] 현재 진행 중인 대기 이벤트
    }
    randomizeStart(){
        // [변경] 시작칸수 기준으로 초기 상태 설정 (예: 3칸 설정 시 1~2칸은 차 있고 3칸째 채우기 시작)
        this.trays = Math.max(1, Math.min(this.startTrays, this.targetTrays));
        this.pieces = 0;
        this.elapsed_time = 0;
        this.production_count = (this.trays - 1) * this.pieces_per_tray;
        global_production[this.model.name] += this.production_count;
    }
    update(sim_dt){
        if (!this.active) return;
        this.targetTrays = eject_threshold; // 전역 배출칸수 동기화
        
        if(this.status==='RUNNING'||this.status==='CALLING'){
            this.elapsed_time+=sim_dt;
            if(this.elapsed_time>=this.cycleTime){
                this.elapsed_time-=this.cycleTime;
                this.pieces++; this.production_count++;
                global_production[this.model.name]++;
                
                // [변경] 트레이가 채워지면 다음 트레이로 넘어가거나 완료 처리
                if(this.pieces >= this.pieces_per_tray){
                    if (this.trays < this.targetTrays) {
                        this.pieces = 0;
                        this.trays++;
                    } else {
                        // 8번째 트레이의 6번째 제품이 채워짐 -> 48개 완료
                        this.pieces = this.pieces_per_tray; // 6개로 고정
                        this.status = 'DONE';
                        this.done_timestamp = manager.global_time;
                    }
                }
            }
            
            // [변경] 호출 기준: 사전배출 사용 시 설정값, 미사용 시 설정 배출칸수(eject_threshold) 시점에 호출
            let callThreshold = use_pre_eject ? this.preEjectTrays : eject_threshold;
            if(this.trays >= callThreshold && this.status === 'RUNNING'){
                this.status = 'CALLING';
            }
        } else if(this.status==='IDLE'&&this.trays===0&&this.pieces===0){
            this.status='RUNNING';
            this.trays = 1; // 배출 후 빈 1번 트레이 배치
        }

        // [변경] 누적 지연 시간 계산 및 히스토리 기록
        if(this.status === 'DONE') {
            this.cumulative_wait += sim_dt;
            stats.totalWait += sim_dt;

            // [NEW] 대기 이벤트 기록 시작
            if (!this.current_wait_event) {
                this.current_wait_event = {
                    startTime: manager.global_time,
                    amrSnapshot: amrs.map(a => `AMR${a.id+1}(${a.state})`).join(', '),
                    waitCount: this.wait_history.length + 1
                };
            }
        } else {
            // [NEW] 대기 이벤트 종료 및 저장
            if (this.current_wait_event) {
                this.current_wait_event.endTime = manager.global_time;
                this.current_wait_event.duration = this.current_wait_event.endTime - this.current_wait_event.startTime;
                this.wait_history.push(this.current_wait_event);
                this.current_wait_event = null;
            }
        }
    }
    draw(ctx,gt){
        if (!this.active) {
            ctx.fillStyle='#94a3b8'; ctx.font='800 14px Inter,sans-serif';
            ctx.textAlign='center'; ctx.textBaseline='middle';
            ctx.fillText('LOADER-'+(this.id+1),this.x,this.y-75);
            ctx.fillStyle='#cbd5e1';
            ctx.beginPath(); ctx.roundRect(this.x-38,this.y-45,76,100,6); ctx.fill();
            ctx.fillStyle='#ef4444'; ctx.font='bold 12px Inter';
            ctx.fillText('OFF',this.x,this.y+10);
            return;
        }

        ctx.fillStyle='#0f172a'; ctx.font='800 14px Inter,sans-serif';
        ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillText('LOADER-'+(this.id+1),this.x,this.y-105);
        ctx.fillStyle='#2563eb'; ctx.font='bold 12px Inter';
        ctx.fillText(this.model.name,this.x,this.y-90);
        
        // V39: 트레이칸수와 생산수를 로더 위쪽으로 이동 (AMR 도킹 시 가림 방지)
        ctx.fillStyle='#64748b'; ctx.font='bold 11px Inter';
        ctx.fillText('('+this.trays+'/'+this.targetTrays+'T)',this.x,this.y-75);
        ctx.fillStyle='#10b981'; ctx.font='bold 12px Inter';
        let currentP = (this.status === 'DONE') ? (this.targetTrays * this.pieces_per_tray) : ((this.trays - 1) * this.pieces_per_tray + this.pieces);
        let targetP = this.targetTrays * this.pieces_per_tray;
        ctx.fillText('생산: '+this.production_count.toLocaleString()+'개 ('+currentP+'/'+targetP+'P)',this.x,this.y-60);

        // [NEW] 호기별 지연 시간(WAIT) 표시
        if (this.cumulative_wait > 0) {
            ctx.fillStyle = '#ef4444'; ctx.font = '800 12px Inter';
            ctx.fillText('대기: ' + formatTime(this.cumulative_wait), this.x, this.y - 120);
        }

        let g=ctx.createLinearGradient(this.x-35,this.y-40,this.x+35,this.y+50);
        g.addColorStop(0,'#ffffff'); g.addColorStop(1,'#e2e8f0');
        ctx.shadowColor='rgba(0,0,0,0.2)'; ctx.shadowBlur=10; ctx.fillStyle=g;
        ctx.beginPath(); ctx.roundRect(this.x-38,this.y-45,76,100,6); ctx.fill();
        ctx.shadowBlur=0; ctx.strokeStyle='#cbd5e1'; ctx.lineWidth=1; ctx.stroke();
        ctx.fillStyle='#1e293b'; ctx.fillRect(this.x+10,this.y-35,22,35);
        ctx.fillStyle='#334155'; ctx.fillRect(this.x+12,this.y-33,18,15);
        
        // [변경] 트레이 칸수 대비 색상 기준 (8단:빨강, 7단:노랑, 6단:초록, 그외:파랑)
        let led = '#2563eb'; 
        if (this.trays >= this.targetTrays) led = '#ef4444';
        else if (this.trays === this.targetTrays - 1) led = '#eab308';
        else if (this.trays === this.targetTrays - 2) led = '#22c55e';
        else if(this.status==='IDLE') led='#94a3b8'; // 회색
        
        ctx.fillStyle=led; ctx.fillRect(this.x+13,this.y-32,16,13);
        ctx.fillStyle='#f1f5f9'; ctx.fillRect(this.x-32,this.y-15,64,60);
        ctx.strokeStyle='rgba(148,163,184,0.5)'; ctx.strokeRect(this.x-32,this.y-15,64,60);
        
        for(let i=0;i<this.targetTrays;i++){
            let ty=this.y+35-(i*7);
            // [변경] 현재 작업 중인 트레이 인덱스는 (this.trays - 1)
            if(i < this.trays - 1){ 
                ctx.fillStyle='#facc15'; ctx.fillRect(this.x-22,ty,44,6); ctx.strokeStyle='#ca8a04'; ctx.strokeRect(this.x-22,ty,44,6); 
            }
            else if(i === this.trays - 1 && (this.status==='RUNNING'||this.status==='CALLING'||this.status==='DONE')){
                // 현재 작업 중인 트레이 (비어있어도 표시)
                ctx.strokeStyle='rgba(148,163,184,0.3)'; ctx.strokeRect(this.x-22,ty,44,6);
                if(this.pieces > 0){
                    ctx.fillStyle='#fef08a'; let pw=44/this.pieces_per_tray;
                    for(let p=0;p<this.pieces;p++) ctx.fillRect(this.x-22+(p*pw),ty,pw-1,6);
                }
            }
        }
        ctx.fillStyle='#eab308'; ctx.beginPath(); ctx.roundRect(this.x-38,this.y+50,76,5,{bl:6,br:6}); ctx.fill();
    }
}

class AMR {
    constructor(id,color){
        this.id=id; this.color=color;
        // 충전 베이 위치: AMR 기본 위치(480)에서 각 1.2m 간격
        let bayY = 480 + (this.id * 1.2 * PX_PER_M);
        this.pos={x: CHARGE_BAY_X, y: bayY};
        this.current_io_model='M3 5X';
        this.state='CHARGING'; // 완충 상태로 대기
        this.speed_mps = 0.8; // m/s (기본: 0.8 m/s)
        this.payload=0;
        this.payload_model=null; this.payload_type=null;
        this.target_ldr=null; this.wait_timer=0;
        this.target_x=CHARGE_BAY_X; this.target_y=bayY;
        this.evade_target=null; this.saved_target_x=null; this.saved_state=null;
        this.next_state=null;
        // Battery
        this.max_battery = 8 * 60 * 60; // 8시간
        this.battery = this.max_battery; // 완충 상태로 시작
        this.min_return_time = 1.5 * 60 * 60; // 1.5시간
        this.charge_count = 0; // [신규] 충전 횟수
        this.charge_counted = false; 
    }

    // [변경] 방향별 속도 이원화 및 전체 효율 80% 적용
    get pxPerSec() {
        const efficiency = 0.8;
        const verticalStates = ['TO_CHARGE_DOCK', 'FROM_CHARGE_DOCK', 'ENTERING_INPUT', 'TO_INPUT_LANE_UP', 'DOCKING_IN', 'DOCKING_OUT', 'TO_OUTPUT_DOCK', 'FROM_OUTPUT_DOCK'];
        let mps = verticalStates.includes(this.state) ? 0.4 : this.speed_mps;
        return (mps * efficiency) * PX_PER_M;
    }

    getTargetLaneY(){ return (dual_lane&&this.payload>0)?OUTPUT_LANE_Y:AMR_LANE_Y; }

    moveTowards(tx,ty,step){
        let dx=tx-this.pos.x, dy=ty-this.pos.y;
        if(Math.abs(dx)>step) this.pos.x+=Math.sign(dx)*step; else this.pos.x=tx;
        if(Math.abs(dy)>step) this.pos.y+=Math.sign(dy)*step; else this.pos.y=ty;
        return (this.pos.x===tx&&this.pos.y===ty);
    }

    update(manager,amrs,ldrs,loadFactor,sim_dt){
        let step = this.pxPerSec * sim_dt; // m/s 기반 이동거리
        
        // Update battery
        if (this.state === 'CHARGING') {
            if(!this.charge_counted){ this.charge_count++; this.charge_counted = true; }
            this.battery += (this.max_battery / (2 * 3600)) * sim_dt;
            if (this.battery > this.max_battery) this.battery = this.max_battery;
        } else {
            this.battery -= 1 * sim_dt;
            if (this.battery < 0) this.battery = 0;
            if (this.state !== 'CHARGING' && this.state !== 'ENTERING_BAY') this.charge_counted = false;
        }

        const myLaneY=this.getTargetLaneY();

        // 동방향 간격 유지 로직 (수평 레인)
        if(Math.abs(this.pos.y-myLaneY)<5){
            let atx=(this.state==='EVADING_TO_X')?this.evade_target:this.target_x;
            if(this.state==='REVERSING_FROM_INPUT_DOCK') atx=getIO('IN',this.current_io_model).exitX;
            if(this.state==='REVERSING_FROM_OUTPUT_DOCK') atx=getIO('OUT',this.current_io_model).exitX;
            if(this.state==='FROM_CHARGE_DOCK') atx=CHARGE_EXIT_NODE.x;
            
            let ahead=amrs.find(o=>{
                if(o.id===this.id) return false;
                if(Math.abs(o.pos.y-myLaneY)>10) return false;
                let otx=(o.state==='EVADING_TO_X')?o.evade_target:o.target_x;
                if(o.state==='REVERSING_FROM_INPUT_DOCK') otx=getIO('IN',o.current_io_model).exitX;
                if(o.state==='REVERSING_FROM_OUTPUT_DOCK') otx=getIO('OUT',o.current_io_model).exitX;
                if(o.state==='FROM_CHARGE_DOCK') otx=CHARGE_EXIT_NODE.x;
                if(atx===this.pos.x) return false;
                let dir=Math.sign(atx-this.pos.x), odir=Math.sign(otx-o.pos.x);
                if(dir===odir||odir===0){
                    if(dir>0&&o.pos.x>this.pos.x&&o.pos.x<=atx) return Math.abs(o.pos.x-this.pos.x)<130;
                    if(dir<0&&o.pos.x<this.pos.x&&o.pos.x>=atx) return Math.abs(o.pos.x-this.pos.x)<130;
                }
                return false;
            });
            if(ahead) return;
        }

        // 수직 레인 (입차, 출차) 충전 라인 간격 유지
        if (this.pos.x === CHARGE_ENTRY_X && this.pos.y > AMR_LANE_Y + 10) {
            let ahead = amrs.find(o => o.id !== this.id && o.pos.x === CHARGE_ENTRY_X && o.pos.y > this.pos.y && Math.abs(o.pos.y - this.pos.y) < 60);
            if (ahead) return;
        }
        if (this.pos.x === CHARGE_EXIT_X && this.pos.y > AMR_LANE_Y + 10) {
            let ahead = amrs.find(o => o.id !== this.id && o.pos.x === CHARGE_EXIT_X && o.pos.y < this.pos.y && Math.abs(o.pos.y - this.pos.y) < 60);
            if (ahead) return;
        }

        // 교차로 양보 로직 (충전 베이 출차 시 입차 라인 양보)
        if (this.state === 'EXITING_BAY') {
            let crossing = amrs.find(o => o.id !== this.id && o.pos.x === CHARGE_ENTRY_X && o.pos.y < this.pos.y + 40 && o.pos.y > this.pos.y - 100);
            if (crossing) return; // 양보
        }

        // 정면충돌 회피 (메인 레인)
        if(this.pos.y===AMR_LANE_Y&&(
            this.state==='MOVING_ON_LANE'||this.state==='TO_INPUT_LANE'||
            this.state==='FROM_OUTPUT_DOCK'||this.state==='REVERSING_FROM_INPUT_DOCK'||
            this.state==='REVERSING_FROM_OUTPUT_DOCK'||this.state==='FROM_CHARGE_DOCK')){
            
            let my_tx=(this.state==='REVERSING_FROM_INPUT_DOCK')?getIO('IN',this.current_io_model).exitX:
                       (this.state==='REVERSING_FROM_OUTPUT_DOCK')?getIO('OUT',this.current_io_model).exitX:
                       (this.state==='FROM_CHARGE_DOCK')?CHARGE_EXIT_NODE.x:this.target_x;
                       
            let threat=amrs.find(o=>{
                if(o.id===this.id) return false;
                
                // 충전 구역 안으로 들어간 AMR은 메인 통로 충돌 위협 리스트에서 완전히 제외
                if (o.state === 'CHARGING' || o.state === 'ENTERING_BAY' || o.state === 'EXITING_BAY' || o.state === 'TO_CHARGE_DOCK') {
                    if (o.pos.y > AMR_LANE_Y + 10) return false;
                }
                
                let otx=(o.state==='EVADING_TO_X')?o.evade_target:o.target_x;
                if(o.state==='REVERSING_FROM_INPUT_DOCK') otx=getIO('IN',o.current_io_model).exitX;
                if(o.state==='REVERSING_FROM_OUTPUT_DOCK') otx=getIO('OUT',o.current_io_model).exitX;
                if(o.state==='FROM_CHARGE_DOCK') otx=CHARGE_EXIT_NODE.x;
                let conflict=false;
                if(Object.values(OUTPUT_ZONES).some(z=>z.entryX===my_tx)){
                    if(Object.values(OUTPUT_ZONES).some(z=>Math.abs(o.pos.x-z.entryX)<50||Math.abs(o.pos.x-z.exitX)<50)&&o.pos.y>DOCKING_Y+10){
                        if(o.state==='UNLOADING'||o.state==='EXIT_OUTPUT_SIDE'||o.state==='FROM_OUTPUT_DOCK'||o.state==='TO_OUTPUT_DOCK') conflict=true;
                    }
                }
                if(Object.values(INPUT_ZONES).some(z=>z.exitX===my_tx)){
                    if(Object.values(INPUT_ZONES).some(z=>Math.abs(o.pos.x-z.entryX)<50||Math.abs(o.pos.x-z.exitX)<50)&&o.pos.y>DOCKING_Y+10){
                        if(o.state==='WAITING_INPUT'||o.state==='TO_INPUT_LANE'||o.state==='TO_INPUT_DOCK'||o.state==='EXIT_INPUT_SIDE') conflict=true;
                    }
                }
                if(my_tx===CHARGE_ENTRY_NODE.x){
                    if(Math.abs(o.pos.x-CHARGE_ENTRY_X)<50&&o.pos.y>DOCKING_Y+10){
                        if(o.state==='ENTERING_BAY'||o.state==='TO_CHARGE_DOCK') conflict=true;
                    }
                }
                if(!conflict){
                    if(o.pos.y>DOCKING_Y+10){
                        let skipFront=false;
                        if(dual_lane){
                            let myL=(this.payload>0)?OUTPUT_LANE_Y:AMR_LANE_Y;
                            let oL=(o.payload>0)?OUTPUT_LANE_Y:AMR_LANE_Y;
                            if(Math.abs(myL-oL)>=15) skipFront=true;
                        }
                        if(!skipFront&&Math.abs(o.pos.x-this.pos.x)<evade_detect_range){
                            if(my_tx!==this.pos.x&&otx!==o.pos.x&&Math.sign(my_tx-this.pos.x)!==Math.sign(otx-o.pos.x)){
                                if((my_tx>this.pos.x&&o.pos.x>this.pos.x)||(my_tx<this.pos.x&&o.pos.x<this.pos.x)) conflict=true;
                            }
                        }
                    }
                }
                if(!conflict) return false;
                
                // NEW: 충전 복귀 차량은 다른 일반 물류(적재/빈차 포함) 방해 금지 (최하위 우선순위 부여)
                let my_charging = (my_tx === CHARGE_ENTRY_NODE.x);
                let o_charging = (otx === CHARGE_ENTRY_NODE.x);
                if (my_charging && !o_charging) return true; // 내가 충전하러가면 무조건 위협(상대방)이 있다고 판단하여 내가 양보함
                if (!my_charging && o_charging) return false; // 상대방이 충전하러가면 나는 무시(우선순위 가짐)
                
                let tl=this.payload>0, ol=o.payload>0;
                let dt=Math.abs(this.pos.y-AMR_LANE_Y), do_=Math.abs(o.pos.y-AMR_LANE_Y);
                if(priority_mode==='LOADED_YIELDS'){
                    if(tl&&!ol) return true; if(!tl&&ol) return false;
                    if(dt<do_) return true; if(dt>do_) return false;
                } else if(priority_mode==='MAIN_LANE_DIST'){
                    if(dt<do_) return true; if(dt>do_) return false;
                } else if(priority_mode==='ID_PRIORITY') return o.id<this.id;
                return o.id<this.id;
            });
            if(threat){
                let cands=getEvadeCandidates(ldrs);
                let free=cands.filter(x=>
                    !amrs.some(a=>a.target_ldr&&a.target_ldr.x===x)&&
                    !amrs.some(a=>a.evade_target===x)&&
                    !amrs.some(a=>Math.abs(a.pos.x-x)<10&&a.pos.y<=DOCKING_Y+10)
                );
                if(free.length>0){
                    let nx=free.sort((a,b)=>Math.abs(a-this.pos.x)-Math.abs(b-this.pos.x))[0];
                    if(this.state!=='EVADING_TO_X'){
                        if(this.state==='REVERSING_FROM_INPUT_DOCK'||this.state==='REVERSING_FROM_OUTPUT_DOCK'||this.state==='FROM_CHARGE_DOCK'){
                            this.saved_state='MOVING_ON_LANE';
                            this.saved_target_x=(this.state==='REVERSING_FROM_INPUT_DOCK')?getIO('IN',this.current_io_model).exitX:
                                                (this.state==='REVERSING_FROM_OUTPUT_DOCK')?getIO('OUT',this.current_io_model).exitX:CHARGE_EXIT_NODE.x;
                        } else {
                            this.saved_state=this.state; this.saved_target_x=this.target_x;
                        }
                    }
                    this.evade_target=nx; this.state='EVADING_TO_X';
                } else return;
            }
        }

        switch(this.state){
                case 'WAITING_INPUT':{
                // V33: CALLING/DONE 로더 있으면 배정, 없으면 충전베이 복귀
                let wiCands = ldrs.filter(l => l.active && (l.status==='DONE'||l.status==='CALLING') && !l.amr_assigned);
                let wiBest = getBestLoader(wiCands);
                if(wiBest && this.battery > this.min_return_time){
                    this.target_ldr = wiBest; this.target_ldr.amr_assigned = true;
                    this.payload_model = this.target_ldr.model.name;
                    this.payload_type = 'IN';
                    this.current_io_model = this.payload_model;
                    this.state = 'MOVING_ON_LANE';
                    this.target_x = getIO('IN', this.payload_model).entryX;
                    this.next_state = 'ENTERING_INPUT';
                } else {
                    this.state = 'MOVING_ON_LANE';
                    this.target_x = CHARGE_ENTRY_NODE.x;
                    this.next_state = 'TO_CHARGE_DOCK';
                }
                break;
            }
case 'TO_CHARGE_DOCK': {
                let bayY = 480 + (this.id * 1.2 * PX_PER_M);
                if(this.moveTowards(CHARGE_ENTRY_X, bayY, step)) {
                    this.state = 'ENTERING_BAY';
                }
                break;
            }
            case 'ENTERING_BAY': {
                let bayY = 480 + (this.id * 1.2 * PX_PER_M);
                if(this.moveTowards(CHARGE_BAY_X, bayY, step)) {
                    this.state = 'CHARGING';
                }
                break;
            }
            case 'CHARGING':
                {
                    // V33: CALLING 또는 DONE 로더 감지 시 출발
                    let callCands = ldrs.filter(l => l.active && (l.status === 'DONE' || l.status === 'CALLING') && !l.amr_assigned);
                    let best = getBestLoader(callCands);
                    if(best && this.battery > this.min_return_time) {
                        this.target_ldr = best;
                        this.target_ldr.amr_assigned = true;
                        this.payload_model = this.target_ldr.model.name;
                        this.payload_type = 'IN';
                        this.current_io_model = this.payload_model;
                        this.state = 'EXITING_BAY';
                    }
                }
                break;
            case 'EXITING_BAY': {
                let bayY = 480 + (this.id * 1.2 * PX_PER_M);
                // 위에서 양보 로직(교차로)은 switch문 전에 처리됨
                if(this.moveTowards(CHARGE_EXIT_X, bayY, step)) {
                    this.state = 'FROM_CHARGE_DOCK';
                }
                break;
            }
            case 'FROM_CHARGE_DOCK':
                if(this.moveTowards(CHARGE_EXIT_X, AMR_LANE_Y, step)) {
                    // CHARGING 단계에서 이미 target_ldr가 배정됨
                    if(this.target_ldr) {
                        this.state = 'MOVING_ON_LANE';
                        this.target_x = getIO('IN', this.payload_model).entryX;
                        this.next_state = 'ENTERING_INPUT';
                    } else {
                        // 예외 코드: 충전소 복귀
                        this.state = 'MOVING_ON_LANE';
                        this.target_x = CHARGE_ENTRY_NODE.x;
                        this.next_state = 'TO_CHARGE_DOCK';
                    }
                }
                break;

            case 'EXIT_INPUT_SIDE':
                if(this.moveTowards(getIO('IN',this.current_io_model).exitX, getIO('IN',this.current_io_model).y, step)){
                    this.state = 'TO_INPUT_LANE_UP';
                }
                break;

            // 신규: AMR이 모델 INPUT entryX에 도착하면 아래로 내려가서 자로화 후 로더로
            case 'ENTERING_INPUT':
                // 투입 준비된 자재는 대상 로더 전용이므로 중간 변경 불가 (사용자 룰 적용)
                if(this.moveTowards(getIO('IN',this.current_io_model).entryX, getIO('IN',this.current_io_model).y, step)){
                    this.state = 'AT_INPUT'; this.wait_timer = 0;
                }
                break;

            case 'AT_INPUT': // 자재 픽업 (30초 대기)
                this.wait_timer += sim_dt;
                if(this.wait_timer >= 30){
                    this.state = 'EXIT_INPUT_SIDE';
                }
                break;

            case 'TO_INPUT_LANE_UP':
                if(this.moveTowards(getIO('IN',this.current_io_model).exitX, AMR_LANE_Y, step)){
                    this.state='MOVING_ON_LANE';
                    if (this.next_state === 'TO_CHARGE_DOCK') {
                        this.target_x = CHARGE_ENTRY_NODE.x;
                    } else {
                        this.target_x = this.target_ldr.x;
                        this.next_state = 'DOCKING_IN';
                    }
                }
                break;

            case 'MOVING_ON_LANE':
                // 이동 중 동적 재배정 제거 (최초 배정 룰 준수)
                if(this.moveTowards(this.target_x, this.getTargetLaneY(), step)){
                    this.state = this.next_state;
                }
                break;

            case 'DOCKING_IN':{
                if(dual_lane){
                    let sc=amrs.find(a=>{
                        if(a.id===this.id) return false;
                        if(Math.abs(a.pos.x-this.target_ldr.x)>60) return false;
                        return a.pos.y<AMR_LANE_Y-10;
                    });
                    if(sc){ let sw=true; if(priority_mode==='ID_PRIORITY') sw=(sc.id<this.id); if(sw) break; }
                }
                if(this.moveTowards(this.target_ldr.x,DOCKING_Y,step)){
                    this.state='LOADING_WAIT'; this.wait_timer=0;
                }
                break;
            }

            case 'LOADING_WAIT':
                // [변경] 수거 조건: 설비가 완료(DONE) 되었거나, 사전 배출 설정값 이상일 때 수거
                let isReady = (this.target_ldr.status === 'DONE' || this.target_ldr.trays >= this.target_ldr.preEjectTrays);
                if(!isReady) return; 
                this.wait_timer += sim_dt;
                if(this.wait_timer > 30){
                    stats.calls++;
                    this.payload = this.target_ldr.trays;
                    this.payload_type = 'OUT';
                    this.target_ldr.trays = 0; this.target_ldr.pieces = 0; 
                    this.target_ldr.elapsed_time = 0; this.target_ldr.status = 'IDLE';
                    this.target_ldr.amr_assigned = false; this.state = 'DOCKING_OUT';
                }
                break;

            case 'DOCKING_OUT':
                if(this.moveTowards(this.target_ldr.x,this.getTargetLaneY(),step)){
                    this.state='MOVING_ON_LANE';
                    this.current_io_model=this.payload_model; this.target_x=getIO('OUT',this.payload_model).entryX;
                    this.next_state='TO_OUTPUT_DOCK';
                }
                break;

            case 'TO_OUTPUT_DOCK':
                if(this.moveTowards(getIO('OUT',this.current_io_model).entryX, getIO('OUT',this.current_io_model).y, step)){
                    this.state='UNLOADING'; this.wait_timer=0;
                }
                break;

            case 'UNLOADING':
                this.wait_timer+=sim_dt;
                if(this.wait_timer>30){
                    this.payload=0; this.target_ldr=null;
                    this.payload_model=null; this.payload_type=null;
                    this.state='EXIT_OUTPUT_SIDE';
                }
                break;

            case 'EXIT_OUTPUT_SIDE':
                if(this.moveTowards(getIO('OUT',this.current_io_model).exitX, getIO('OUT',this.current_io_model).y, step)){
                    this.state='FROM_OUTPUT_DOCK';
                }
                break;

            case 'FROM_OUTPUT_DOCK':
                if(this.moveTowards(getIO('OUT',this.current_io_model).exitX, AMR_LANE_Y, step)){
                    let canCharge3 = this.battery <= this.min_return_time;
                    // V33: CALLING 또는 DONE 로더 후보
                    let nextCands = ldrs.filter(l => l.active && (l.status === 'DONE' || l.status === 'CALLING') && !l.amr_assigned);
                    let nextBest = getBestLoader(nextCands);
                    if(!canCharge3 && nextBest){
                        this.target_ldr = nextBest; this.target_ldr.amr_assigned = true;
                        this.payload_model = this.target_ldr.model.name;
                        this.payload_type = 'IN';
                        this.current_io_model = this.payload_model;
                        this.state = 'MOVING_ON_LANE';
                        this.target_x = getIO('IN', this.payload_model).entryX;
                        this.next_state = 'ENTERING_INPUT';
                    } else {
                        this.state = 'MOVING_ON_LANE';
                        this.target_x = CHARGE_ENTRY_NODE.x;
                        this.next_state = 'TO_CHARGE_DOCK';
                    }
                }
                break;

            case 'TO_INPUT_DOCK':
                if(this.moveTowards(getIO('IN',this.current_io_model).entryX, getIO('IN',this.current_io_model).y, step)){
                    this.state='WAITING_INPUT';
                }
                break;

            case 'REVERSING_FROM_OUTPUT_DOCK':
                if(this.moveTowards(getIO('OUT',this.current_io_model).exitX,AMR_LANE_Y,step)){
                    this.state='MOVING_ON_LANE'; this.target_x=getIO('OUT',this.current_io_model).exitX; this.next_state='TO_OUTPUT_DOCK';
                }
                break;

            case 'REVERSING_FROM_INPUT_DOCK':
                if(this.moveTowards(getIO('IN',this.current_io_model).exitX,AMR_LANE_Y,step)){
                    this.state='MOVING_ON_LANE'; this.target_x=getIO('IN',this.current_io_model).exitX; this.next_state='TO_INPUT_DOCK';
                }
                break;

            case 'EVADING_TO_X':
                if(this.moveTowards(this.evade_target,AMR_LANE_Y,step)) this.state='EVADING_UP';
                break;

            case 'EVADING_UP':
                if(this.moveTowards(this.evade_target,DOCKING_Y,step)) {
                    this.state='EVADING_WAIT'; 
                    this.wait_timer = 0; // 회피 진입 시 대기 타이머 초기화
                }
                break;

            case 'EVADING_WAIT':{
                this.wait_timer += sim_dt;
                if(this.wait_timer < 14) return; // 14초 지연 대기

                let stx=this.saved_target_x;
                let still=amrs.some(a=>{
                    if(a.id===this.id) return false;
                    let atx=(a.state==='EVADING_TO_X')?a.evade_target:a.target_x;
                    if(a.state==='REVERSING_FROM_INPUT_DOCK') atx=getIO('IN',a.current_io_model).exitX;
                    if(a.state==='REVERSING_FROM_OUTPUT_DOCK') atx=getIO('OUT',a.current_io_model).exitX;
                    if(a.state==='FROM_CHARGE_DOCK') atx=CHARGE_EXIT_NODE.x;
                    let conflict=false;
                    if(Object.values(OUTPUT_ZONES).some(z=>z.entryX===stx)){
                        if(Object.values(OUTPUT_ZONES).some(z=>Math.abs(a.pos.x-z.entryX)<50||Math.abs(a.pos.x-z.exitX)<50)&&a.pos.y>DOCKING_Y+10){
                            if(a.state==='UNLOADING'||a.state==='EXIT_OUTPUT_SIDE'||a.state==='FROM_OUTPUT_DOCK'||a.state==='TO_OUTPUT_DOCK') conflict=true;
                        }
                    }
                    if(Object.values(INPUT_ZONES).some(z=>z.exitX===stx)){
                        if(Object.values(INPUT_ZONES).some(z=>Math.abs(a.pos.x-z.entryX)<50||Math.abs(a.pos.x-z.exitX)<50)&&a.pos.y>DOCKING_Y+10){
                            if(a.state==='WAITING_INPUT'||a.state==='TO_INPUT_LANE_UP'||a.state==='TO_INPUT_DOCK'||a.state==='EXIT_INPUT_SIDE') conflict=true;
                        }
                    }
                    if(stx===CHARGE_ENTRY_NODE.x){
                        if(Math.abs(a.pos.x-CHARGE_ENTRY_X)<50&&a.pos.y>DOCKING_Y+10){
                            if(a.state==='ENTERING_BAY'||a.state==='TO_CHARGE_DOCK'||a.state==='CHARGING') conflict=true;
                        }
                    }
                    if(!conflict){
                        if(a.pos.y>DOCKING_Y+10&&Math.abs(a.pos.x-this.evade_target)<evade_detect_range){
                            if(stx!==this.evade_target&&atx!==a.pos.x&&Math.sign(stx-this.evade_target)!==Math.sign(atx-a.pos.x)){
                                if((stx>this.evade_target&&a.pos.x>this.evade_target)||(stx<this.evade_target&&a.pos.x<this.evade_target)) conflict=true;
                            }
                        }
                    }
                    if(!conflict) return false;
                    
                    // 회피 대기 중일 때도 동일하게 충전 차량 양보 우선순위 적용
                    let my_charging = (stx === CHARGE_ENTRY_NODE.x);
                    let a_charging = (atx === CHARGE_ENTRY_NODE.x);
                    if (my_charging && !a_charging) return true;
                    if (!my_charging && a_charging) return false;
                    
                    let tl=this.payload>0, al=a.payload>0;
                    if(priority_mode==='LOADED_YIELDS'){
                        if(tl&&!al) return true; if(!tl&&al) return false;
                    } else if(priority_mode==='ID_PRIORITY') return a.id<this.id;
                    return a.id<this.id;
                });
                let blk=amrs.some(a=>a.id!==this.id&&Math.abs(a.pos.y-AMR_LANE_Y)<10&&Math.abs(a.pos.x-this.evade_target)<60);
                if(!still&&!blk) this.state='EVADING_DOWN';
                break;
            }
            case 'EVADING_DOWN':
                if(this.moveTowards(this.evade_target,AMR_LANE_Y,step)) this.state='MOVING_ON_LANE';
                break;
        }
    }
    
    draw(ctx){
        ctx.save(); ctx.translate(this.pos.x,this.pos.y);
        ctx.shadowColor='rgba(0,0,0,0.3)'; ctx.shadowBlur=8;
        let g=ctx.createLinearGradient(-25,-15,25,15);
        g.addColorStop(0,'#f8fafc'); g.addColorStop(1,'#cbd5e1');
        ctx.fillStyle=g; ctx.beginPath(); ctx.roundRect(-25,-18,50,36,6); ctx.fill();
        ctx.shadowBlur=0; ctx.lineWidth=2; ctx.strokeStyle='#475569'; ctx.stroke();
        
        // 바퀴 및 조명 효과
        ctx.fillStyle='#0f172a'; ctx.fillRect(15,-10,10,20); ctx.fillRect(-25,-10,10,20);
        ctx.fillStyle='#3b82f6'; ctx.beginPath();
        ctx.arc(20,-5,2,0,Math.PI*2); ctx.arc(20,5,2,0,Math.PI*2);
        ctx.arc(-20,-5,2,0,Math.PI*2); ctx.arc(-20,5,2,0,Math.PI*2); ctx.fill();
        
        if (this.payload_model) {
            // 적재물 표시
            let pColor = this.payload_type==='OUT' ? '#facc15' : '#38bdf8';
            let pBorder = this.payload_type==='OUT' ? '#ca8a04' : '#0284c7';
            ctx.fillStyle=pColor; ctx.fillRect(-18,-12,36,24);
            ctx.strokeStyle=pBorder; ctx.strokeRect(-18,-12,36,24);
            ctx.fillStyle='#0f172a'; ctx.font='800 9px Inter';
            ctx.textAlign='center'; ctx.textBaseline='middle';
            let txt = `${this.payload_type==='IN'?'투입':'배출'}`;
            ctx.fillText(txt, 0, -4);
            ctx.font='700 8px Inter';
            ctx.fillText(this.payload_model.replace('M3 ',''), 0, 6);
        } else {
            // 빈 차량 상태
            ctx.fillStyle=(this.payload===0&&this.target_ldr)?'#ec4899':this.color;
            ctx.beginPath(); ctx.roundRect(-22,-10,44,20,4); ctx.fill();
            ctx.fillStyle='#ffffff'; ctx.font='800 10px Inter';
            ctx.textAlign='center'; ctx.textBaseline='middle';
            let lbl='A'+(this.id+1);
            ctx.fillText(lbl,0,0);
        }
        ctx.restore();
    }
}

let manager, ldrs=[], amrs=[];

function setupLoaderGrid() {
    const grid = document.getElementById('loaderGrid');
    grid.innerHTML = '';
    ldrs.forEach((l, i) => {
        const div = document.createElement('div');
        div.className = 'loader-setting';
        const labelStyle = use_pre_eject ? 'color:#2563eb; font-weight:bold;' : 'color:#64748b;';
        div.innerHTML = `
            <div class="loader-setting-header">
                <span>#${i+1}</span>
                <span id="st-${i}" class="${l.active ? 'status-on' : 'status-off'}">${l.active ? 'ON' : 'OFF'}</span>
            </div>
            <select onchange="window.updateLoaderModel(${i}, this.value)">
                ${MODELS.map(m => `<option value="${m.name}" ${l.model.name === m.name ? 'selected' : ''}>${m.name}</option>`).join('')}
            </select>
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <span style="color:#64748b">초/1개:</span>
                <input type="number" id="ct-input-${i}" value="${l.cycleTime}" onchange="ldrs[${i}].cycleTime = parseInt(this.value)">
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <span style="color:#64748b">시작칸수:</span>
                <input type="number" value="${l.startTrays}" min="1" max="8" onchange="window.setLoaderStartTray(${i}, parseInt(this.value))">
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <span id="pre-eject-label-${i}" style="${labelStyle}">사전배출:</span>
                <input type="number" value="${l.preEjectTrays}" min="1" max="9" onchange="window.setLoaderPreEject(${i}, parseInt(this.value))">
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; background:#f1f5f9; padding:4px 8px; border-radius:6px; transition: all 0.2s ease;">
                <span style="font-weight:800; font-size:11px;">물류대기:</span>
                <span id="ldr-wait-${i}" style="font-weight:800; font-size:13px; font-family:JetBrains Mono, monospace;">00:00:00</span>
            </div>
            <div style="display:flex; gap:4px;">
                <button class="btn btn-toggle" style="flex:1" onclick="window.toggleLoader(${i})">Toggle</button>
                <button class="btn" style="flex:1; background:#6366f1; color:white; font-size:11px; padding:4px;" onclick="window.showLoaderLog(${i})">상세로그</button>
            </div>
        `;
        grid.appendChild(div);
    });
}

function setupAmrGrid() {
    const grid = document.getElementById('amrGrid');
    grid.innerHTML = '';
    amrs.forEach((a, i) => {
        const div = document.createElement('div');
        div.className = 'amr-setting';
        div.innerHTML = `
            <div class="amr-setting-header">
                <span style="color:${a.color}">AMR #${i+1}</span>
            </div>
            <div class="amr-battery-bar-container">
                <div id="amr-bat-bar-${i}" class="amr-battery-bar" style="width:100%"></div>
            </div>
            <div class="amr-battery-info" id="amr-bat-text-${i}">8h 0m (100%)</div>
            <div class="amr-controls">
                <span>속도:</span>
                <button class="btn-small" onclick="window.adjAmrSpeed(${i}, -0.1)">▼</button>
                <span id="amr-spd-${i}">${a.speed_mps.toFixed(1)}m/s</span>
                <button class="btn-small" onclick="window.adjAmrSpeed(${i}, 0.1)">▲</button>
            </div>
            <div class="amr-controls">
                <span>복귀:</span>
                <button class="btn-small" onclick="window.adjAmrReturnTime(${i}, -1800)">-</button>
                <span id="amr-ret-time-${i}">${(a.min_return_time / 3600).toFixed(1)}h</span>
                <button class="btn-small" onclick="window.adjAmrReturnTime(${i}, 1800)">+</button>
            </div>
        `;
        grid.appendChild(div);
    });
}

window.adjAmrSpeed = function(i, diff) {
    if(!amrs[i]) return;
    let newSpd = Math.round((amrs[i].speed_mps + diff) * 10) / 10;
    if(newSpd < 0.1) newSpd = 0.1;
    if(newSpd > 5.0) newSpd = 5.0;
    amrs[i].speed_mps = newSpd;
    document.getElementById(`amr-spd-${i}`).innerText = newSpd.toFixed(1) + 'm/s';
};

window.setLoaderStartTray = function(i, val) {
    if(!ldrs[i]) return;
    ldrs[i].startTrays = Math.min(val, ldrs[i].targetTrays);
};

window.setLoaderPreEject = function(i, val) {
    if(!ldrs[i]) return;
    ldrs[i].preEjectTrays = Math.min(val, eject_threshold);
};

window.adjAmrReturnTime = function(i, diff) {
    if(!amrs[i]) return;
    let newTime = amrs[i].min_return_time + diff;
    if(newTime < 1800) newTime = 1800; // min 0.5h
    if(newTime > 8 * 3600) newTime = 8 * 3600; // max 8h
    amrs[i].min_return_time = newTime;
    document.getElementById(`amr-ret-time-${i}`).innerText = (newTime / 3600).toFixed(1) + "h";
};

window.updateLoaderModel = function(i, modelName) {
    const m = MODELS.find(x => x.name === modelName);
    if (m) {
        ldrs[i].model = m;
        ldrs[i].cycleTime = m.ct; // V33: 모델 변경 시 cycleTime도 즉시 동기화
        const ctInput = document.getElementById(`ct-input-${i}`);
        if(ctInput) ctInput.value = m.ct;
    }
};

window.toggleLoader = function(i) {
    ldrs[i].active = !ldrs[i].active;
    const span = document.getElementById(`st-${i}`);
    span.innerText = ldrs[i].active ? "ON" : "OFF";
    span.className = ldrs[i].active ? "status-on" : "status-off";
};

function init(){
    manager = new SimulationManager();
    manager.speed = 1; // [변경] 기본 1배속 설정
    manager.targetHours = 10; // [변경] 기본 10시간 설정
    global_production={'M3 5X':0,'M3 UPPER':0,'M3 2ND':0};
    document.getElementById('prod-m3-5x').innerText='0';
    document.getElementById('prod-m3-upper').innerText='0';
    document.getElementById('prod-m3-2nd').innerText='0';
    updateExtraSidings();
    ldrs=[]; amrs=[];
    const gap = CORRIDOR_PX / (NUM_LOADER - 1);
    for(let i=0;i<NUM_LOADER;i++){
        let l=new Loader(i,80+i*gap); ldrs.push(l);
    }
    // 시작단 자동 배분
    let modelGroups = {};
    ldrs.forEach(l => {
        if(!modelGroups[l.model.name]) modelGroups[l.model.name] = [];
        modelGroups[l.model.name].push(l);
    });
    Object.values(modelGroups).forEach(group => {
        group.forEach((l, idx) => { l.startTrays = (idx % 8) + 1; }); // [변경] 1~8 범위 배분
    });
    ldrs.forEach(l => l.randomizeStart());
    stats = { calls: 0, totalWait: 0 };
    setupLoaderGrid();
    // 기본 2대
    amrs.push(new AMR(0,COLOR_AMR[0]));
    amrs.push(new AMR(1,COLOR_AMR[1]));
    setupAmrGrid();
    lastTime = null;
    
    // V36: 초기 버튼 상태 설정
    const btnPause = document.getElementById('btn-pause');
    if(btnPause) setActive('#btn-pause,#btn-start,#btn-backward', btnPause);
    const btn1x = document.getElementById('btn-1x');
    if(btn1x) setActive('#btn-1x,#btn-5x,#btn-10x,#btn-20x,#btn-50x,#btn-100x,#btn-200x,#btn-500x', btn1x);
}

function update(dt){
    let sim_dt = dt * manager.speed;
    manager.update(sim_dt);
    if (!manager.paused && manager.mode === 'FORWARD') {
        ldrs.forEach(l=>l.update(sim_dt));
        let loadFactor = runAnalysis(sim_dt);
        amrs.forEach(a=>a.update(manager,amrs,ldrs,loadFactor,sim_dt));
    } else {
        runAnalysis(0); // [변경] 정지 상태에서도 UI(배터리 등) 갱신
        if (!manager.paused && manager.mode === 'REVERSE') {
            // manager.update 내에서 rewind() 수행됨
        }
    }
}

function drawEvadeHighlight(ctx,zones){
    zones.forEach(z=>{
        ctx.fillStyle='rgba(124,58,237,0.07)';
        ctx.fillRect(z.x-44,DOCKING_Y-55,88,110);
        ctx.strokeStyle='rgba(124,58,237,0.30)'; ctx.lineWidth=1.5;
        ctx.setLineDash([5,4]); ctx.strokeRect(z.x-44,DOCKING_Y-55,88,110); ctx.setLineDash([]);
        ctx.fillStyle='rgba(124,58,237,0.65)'; ctx.font='bold 10px Inter';
        ctx.textAlign='center';
        ctx.fillText('회피구간',z.x,DOCKING_Y-60);
    });
}

function draw(){
    ctx.clearRect(0,0,WIDTH,HEIGHT);

    // 보행자 레인
    ctx.fillStyle=COLOR_PED_LANE; ctx.fillRect(0,PED_LANE_Y-25,WIDTH,50);
    ctx.fillStyle='#64748b'; ctx.font='800 14px Inter'; ctx.textAlign='left';
    ctx.fillText('보행자',20,PED_LANE_Y+5);

    // 배출(OUTPUT) 2라인 표시
    if(dual_lane){
        ctx.fillStyle='rgba(59,130,246,0.1)'; ctx.fillRect(0,OUTPUT_LANE_Y-15,WIDTH,30);
        ctx.beginPath(); ctx.moveTo(0,OUTPUT_LANE_Y); ctx.lineTo(WIDTH,OUTPUT_LANE_Y);
        ctx.strokeStyle='#3b82f6'; ctx.lineWidth=2; ctx.setLineDash([8,4]); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle='#3b82f6'; ctx.font='800 12px Inter'; ctx.textAlign='left';
        ctx.fillText('배출 경로 (2라인)',20,OUTPUT_LANE_Y+12);
    }

    // 투입 레인
    ctx.fillStyle=COLOR_AMR_LANE;
    let lh=dual_lane?(OUTPUT_LANE_Y-AMR_LANE_Y+30):50;
    ctx.fillRect(0,AMR_LANE_Y-25,WIDTH,lh);
    ctx.beginPath(); ctx.moveTo(0,AMR_LANE_Y); ctx.lineTo(WIDTH,AMR_LANE_Y);
    ctx.strokeStyle=COLOR_AMR_LINE; ctx.lineWidth=2; ctx.stroke();
    ctx.fillStyle=COLOR_AMR_LINE; ctx.font='800 12px Inter'; ctx.textAlign='left';
    ctx.fillText(dual_lane?'투입 경로 (1라인)':'AMR',20,AMR_LANE_Y-10);

    // 회피구간 하이라이트
    let evZones=[];
    if(evade_mode==='CNC_ONLY') evZones=ldrs.map(l=>({x:l.x}));
    else if(evade_mode==='SIDING_ONLY') evZones=extra_sidings.map(s=>({x:s.x}));
    else evZones=[...ldrs.map(l=>({x:l.x})),...extra_sidings.map(s=>({x:s.x}))];
    drawEvadeHighlight(ctx,evZones);

    // 로더 도킹 라인 (위쪽)
    function drawDockUp(x){
        ctx.strokeStyle='rgba(234,88,12,0.4)'; ctx.lineWidth=2; ctx.setLineDash([5,5]);
        ctx.beginPath(); ctx.moveTo(x,AMR_LANE_Y); ctx.lineTo(x,DOCKING_Y); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x-30,AMR_LANE_Y-10); ctx.lineTo(x-30,DOCKING_Y-20);
        ctx.lineTo(x+30,DOCKING_Y-20); ctx.lineTo(x+30,AMR_LANE_Y-10); ctx.stroke();
    }
    ldrs.forEach(l=>drawDockUp(l.x));

    // 추가 회피존 표시 (SIDING)
    extra_sidings.forEach((s,i)=>{
        drawDockUp(s.x);
        ctx.fillStyle='#38bdf8'; ctx.font='bold 11px Inter'; ctx.textAlign='center';
        ctx.fillText('S'+(i+1),s.x,DOCKING_Y-35);
    });

        // ===== MULTI INPUT ZONES =====
    Object.values(INPUT_ZONES).forEach((zone, i) => {
        let ix=zone.entryX, iy=zone.y;
        let iEntX=zone.entryX, iExX=zone.exitX;
        let iLaneY=dual_lane?OUTPUT_LANE_Y:AMR_LANE_Y;
        let modelNames = ['M3 5X', 'M3 UPPER', 'M3 2ND'];
        
        ctx.strokeStyle='rgba(234,88,12,0.6)'; ctx.lineWidth=2; ctx.setLineDash([5,5]);
        ctx.beginPath(); ctx.moveTo(iEntX,iLaneY); ctx.lineTo(iEntX,iy-45); ctx.stroke(); ctx.setLineDash([]);
        ctx.strokeStyle='rgba(16,185,129,0.6)'; ctx.lineWidth=2; ctx.setLineDash([5,5]);
        ctx.beginPath(); ctx.moveTo(iExX,iLaneY); ctx.lineTo(iExX,iy-45); ctx.stroke(); ctx.setLineDash([]);
        ctx.strokeStyle='rgba(234,88,12,0.4)'; ctx.lineWidth=2;
        ctx.beginPath();
        ctx.moveTo(iExX-10,iLaneY+10); ctx.lineTo(iExX-10,iy+50);
        ctx.lineTo(iEntX+10,iy+50); ctx.lineTo(iEntX+10,iLaneY+10); ctx.stroke();
        
        ctx.fillStyle='rgba(234,88,12,0.8)'; ctx.font='bold 9px Inter'; ctx.textAlign='center';
        ctx.fillText('▼입차',iEntX,iLaneY+14);
        ctx.fillStyle='rgba(16,185,129,0.9)';
        ctx.fillText('▲출차',iExX,iLaneY+14);
        
        ctx.shadowColor='rgba(0,0,0,0.1)'; ctx.shadowBlur=5;
        ctx.fillStyle='#fde68a';
        ctx.beginPath(); ctx.roundRect(iExX-15,iy-45,iEntX-iExX+30,90,12); ctx.fill();
        ctx.shadowBlur=0; ctx.strokeStyle='#334155'; ctx.lineWidth=2; ctx.stroke();
        ctx.fillStyle='#0f172a'; ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.font='700 11px Inter'; ctx.fillText('IN ' + modelNames[i].replace('M3 ',''),(iEntX+iExX)/2,iy);
    });
// ===== CHARGE 전용 라인 및 베이 (4칸) =====
    let cExX = CHARGE_EXIT_X, cEntX = CHARGE_ENTRY_X;
    ctx.strokeStyle='rgba(16,185,129,0.6)'; ctx.lineWidth=2; ctx.setLineDash([5,5]);
    ctx.beginPath(); ctx.moveTo(cExX, AMR_LANE_Y); ctx.lineTo(cExX, 700); ctx.stroke();
    ctx.strokeStyle='rgba(234,88,12,0.6)';
    ctx.beginPath(); ctx.moveTo(cEntX, AMR_LANE_Y); ctx.lineTo(cEntX, 700); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle='rgba(16,185,129,0.9)'; ctx.font='bold 10px Inter'; ctx.textAlign='center';
    ctx.fillText('▲출차', cExX, AMR_LANE_Y+14);
    ctx.fillStyle='rgba(234,88,12,0.9)';
    ctx.fillText('▼입차', cEntX, AMR_LANE_Y+14);

    for (let i = 0; i < 4; i++) {
        let bayY = 480 + (i * 1.2 * PX_PER_M);
        ctx.fillStyle='#f1f5f9'; ctx.fillRect(CHARGE_BAY_X-40, bayY-20, 80, 40);
        ctx.strokeStyle='rgba(59,130,246,0.4)'; ctx.lineWidth=2;
        ctx.beginPath(); ctx.moveTo(cExX, bayY); ctx.lineTo(CHARGE_BAY_X, bayY); ctx.stroke();
        
        ctx.shadowColor='rgba(0,0,0,0.1)'; ctx.shadowBlur=5;
        ctx.fillStyle='#bfdbfe';
        ctx.beginPath(); ctx.roundRect(CHARGE_BAY_X - 25, bayY - 20, 50, 40, 8); ctx.fill();
        ctx.shadowBlur=0; ctx.strokeStyle='#2563eb'; ctx.lineWidth=2; ctx.stroke();
        ctx.fillStyle='#1e3a8a'; ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.font='700 10px Inter'; ctx.fillText('충전 #'+(i+1), CHARGE_BAY_X, bayY);

        // [변경] 충전 횟수 표시 시인성 개선 (단독 UI 구성)
        if(amrs[i]) {
            ctx.fillStyle = '#1e40af'; ctx.font = '800 11px Inter'; ctx.textAlign = 'left';
            ctx.fillText(amrs[i].charge_count + '회', CHARGE_BAY_X + 35, bayY);
        }
    }

        // ===== MULTI OUTPUT ZONES =====
    Object.values(OUTPUT_ZONES).forEach((zone, i) => {
        let ox=zone.entryX, oy=zone.y;
        let oEntX=zone.entryX, oExX=zone.exitX;
        let modelNames = ['M3 5X', 'M3 UPPER', 'M3 2ND'];

        ctx.strokeStyle='rgba(59,130,246,0.6)'; ctx.lineWidth=2; ctx.setLineDash([5,5]);
        ctx.beginPath(); ctx.moveTo(oEntX,AMR_LANE_Y); ctx.lineTo(oEntX,oy+45); ctx.stroke(); ctx.setLineDash([]);
        ctx.strokeStyle='rgba(139,92,246,0.6)'; ctx.lineWidth=2; ctx.setLineDash([5,5]);
        ctx.beginPath(); ctx.moveTo(oExX,AMR_LANE_Y); ctx.lineTo(oExX,oy+45); ctx.stroke(); ctx.setLineDash([]);
        ctx.strokeStyle='rgba(59,130,246,0.4)'; ctx.lineWidth=2;
        ctx.beginPath();
        ctx.moveTo(oEntX-10,AMR_LANE_Y-10); ctx.lineTo(oEntX-10,oy-50);
        ctx.lineTo(oExX+10,oy-50); ctx.lineTo(oExX+10,AMR_LANE_Y-10); ctx.stroke();
        
        ctx.fillStyle='rgba(59,130,246,0.9)'; ctx.font='bold 9px Inter'; ctx.textAlign='center';
        ctx.fillText('▲입차',oEntX,AMR_LANE_Y-14);
        ctx.fillStyle='rgba(139,92,246,0.9)';
        ctx.fillText('▼출차',oExX,AMR_LANE_Y-14);
        
        ctx.shadowColor='rgba(0,0,0,0.1)'; ctx.shadowBlur=5;
        ctx.fillStyle='#bfdbfe';
        ctx.beginPath(); ctx.roundRect(oEntX-15,oy-45,oExX-oEntX+30,90,12); ctx.fill();
        ctx.shadowBlur=0; ctx.strokeStyle='#334155'; ctx.lineWidth=2; ctx.stroke();
        ctx.fillStyle='#0f172a'; ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.font='700 11px Inter'; ctx.fillText('OUT ' + modelNames[i].replace('M3 ',''),(oEntX+oExX)/2,oy);
    });
    ldrs.forEach(l=>l.draw(ctx,manager.global_time));
    amrs.forEach(a=>a.draw(ctx));
}

let lastTime = null;
function loop(timestamp){ 
    if(!timestamp) { requestAnimationFrame(loop); return; }
    if(lastTime === null) lastTime = timestamp;
    let dt = (timestamp - lastTime) / 1000;
    lastTime = timestamp;
    if (dt > 0.1) dt = 0.1;
    
    updateClocks(); 
    update(dt); 
    draw(); 
    requestAnimationFrame(loop); 
}

const setActive=(sel,tgt)=>{
    document.querySelectorAll(sel).forEach(b=>b.classList.remove('active'));
    tgt.classList.add('active');
};

document.getElementById('btn-start').addEventListener('click',e=>{
    manager.paused=false; manager.mode='FORWARD';
    setActive('#btn-pause,#btn-start,#btn-backward',e.target);
});
document.getElementById('btn-backward').addEventListener('click',e=>{
    manager.paused=false; manager.mode='REVERSE';
    setActive('#btn-pause,#btn-start,#btn-backward',e.target);
});
document.getElementById('btn-pause').addEventListener('click',e=>{
    manager.paused=true;
    setActive('#btn-pause,#btn-start,#btn-backward',e.target);
});
document.getElementById('btn-1x').addEventListener('click',e=>{manager.speed=1;setActive('#btn-1x,#btn-5x,#btn-10x,#btn-20x,#btn-50x,#btn-100x,#btn-200x,#btn-500x',e.target);});
document.getElementById('btn-5x').addEventListener('click',e=>{manager.speed=5;setActive('#btn-1x,#btn-5x,#btn-10x,#btn-20x,#btn-50x,#btn-100x,#btn-200x,#btn-500x',e.target);});
document.getElementById('btn-10x').addEventListener('click',e=>{manager.speed=10;setActive('#btn-1x,#btn-5x,#btn-10x,#btn-20x,#btn-50x,#btn-100x,#btn-200x,#btn-500x',e.target);});
document.getElementById('btn-20x').addEventListener('click',e=>{manager.speed=20;setActive('#btn-1x,#btn-10x,#btn-20x,#btn-50x,#btn-100x,#btn-200x,#btn-500x',e.target);});
document.getElementById('btn-50x').addEventListener('click',e=>{manager.speed=50;setActive('#btn-1x,#btn-10x,#btn-20x,#btn-50x,#btn-100x,#btn-200x,#btn-500x',e.target);});
document.getElementById('btn-100x').addEventListener('click',e=>{manager.speed=100;setActive('#btn-1x,#btn-10x,#btn-20x,#btn-50x,#btn-100x,#btn-200x,#btn-500x',e.target);});
document.getElementById('btn-200x').addEventListener('click',e=>{manager.speed=200;setActive('#btn-1x,#btn-10x,#btn-20x,#btn-50x,#btn-100x,#btn-200x,#btn-500x',e.target);});
document.getElementById('btn-500x').addEventListener('click',e=>{manager.speed=500;setActive('#btn-1x,#btn-10x,#btn-20x,#btn-50x,#btn-100x,#btn-200x,#btn-500x',e.target);});

// [NEW] 조업 목표 시간 설정 리스너
document.getElementById('select-target-time').addEventListener('change', e => {
    manager.targetHours = parseInt(e.target.value);
});

// V32: 호출칸수 입력 (1~9 범위, 목표단수와 상호호환)
document.getElementById('input-call-threshold').addEventListener('change',e=>{
    let val = parseInt(e.target.value);
    if(isNaN(val) || val < 1) val = 1;
    if(val > 9) val = 9;
    eject_threshold = val;
    e.target.value = val;
});

document.getElementById('select-priority').addEventListener('change',e=>{priority_mode=e.target.value;});

// [NEW] 사전배출 사용 여부 토글 리스너
document.getElementById('check-pre-eject').addEventListener('change', e => { 
    use_pre_eject = e.target.checked; 
    setupLoaderGrid(); // [변경] 토글 시 UI 라벨 색상 즉시 업데이트
});

// [NEW] 상세 로그 모달 기능
window.showLoaderLog = function(i) {
    const l = ldrs[i];
    const modal = document.getElementById('logModal');
    const content = document.getElementById('logContent');
    if (!modal || !content) return;

    let html = `<h3>Loader #${i+1} 대기지연 이력</h3>`;
    html += `<p style="margin-bottom:10px; color:#64748b;">총 대기 횟수: ${l.wait_history.length}회 / 누적 대기시간: ${formatTime(l.cumulative_wait)}</p>`;
    
    if (l.wait_history.length === 0) {
        html += `<div style="padding:20px; text-align:center; color:#94a3b8;">대기 기록이 없습니다.</div>`;
    } else {
        html += `<div class="log-table-container">
            <table class="log-table">
                <thead>
                    <tr>
                        <th>횟수</th>
                        <th>시점</th>
                        <th>대기시간</th>
                        <th>당시 상황 (AMR 상태)</th>
                    </tr>
                </thead>
                <tbody>`;
        
        [...l.wait_history].reverse().forEach(ev => {
            html += `<tr>
                <td>${ev.waitCount}</td>
                <td>${formatTime(ev.startTime)}</td>
                <td class="wait-duration">${formatTime(ev.duration)}</td>
                <td><span class="amr-snapshot">${ev.amrSnapshot}</span></td>
            </tr>`;
        });
        
        html += `</tbody></table></div>`;
    }
    
    content.innerHTML = html;
    modal.style.display = 'flex';
};

window.closeLogModal = function() {
    const modal = document.getElementById('logModal');
    if (modal) modal.style.display = 'none';
};

document.getElementById('btn-lane1').addEventListener('click',e=>{
    dual_lane=false; setActive('#btn-lane1,#btn-lane2',e.target);
    document.getElementById('btn-lane2').textContent='+배출 2라인 추가';
});
document.getElementById('btn-lane2').addEventListener('click',e=>{
    dual_lane=!dual_lane; manager.history=[]; // [변경] 설정 변경 시 히스토리 초기화
    if(dual_lane){e.target.classList.add('active');document.getElementById('btn-lane1').classList.remove('active');e.target.textContent='배출 2라인 삭제';}
    else{e.target.classList.remove('active');document.getElementById('btn-lane1').classList.add('active');e.target.textContent='+배출 2라인 추가';}
    draw(); // [변경] 즉각 시각화 반영
});

document.getElementById('btn-evade-cnc').addEventListener('click',e=>{
    evade_mode='CNC_ONLY'; extra_sidings=[]; manager.history=[]; 
    setActive('#btn-evade-cnc,#btn-evade-siding,#btn-evade-both',e.target); draw();
});
document.getElementById('btn-evade-siding').addEventListener('click',e=>{
    evade_mode='SIDING_ONLY'; updateExtraSidings(); manager.history=[];
    setActive('#btn-evade-cnc,#btn-evade-siding,#btn-evade-both',e.target); draw();
});
document.getElementById('btn-evade-both').addEventListener('click',e=>{
    evade_mode='BOTH'; updateExtraSidings(); manager.history=[];
    setActive('#btn-evade-cnc,#btn-evade-siding,#btn-evade-both',e.target); draw();
});

document.getElementById('input-detect-range').addEventListener('input',e=>{
    evade_detect_range = parseInt(e.target.value);
    document.getElementById('val-detect-range').innerText = evade_detect_range + 'px';
});

document.getElementById('btn-amr1').addEventListener('click',e=>{setActive('#btn-amr1,#btn-amr2,#btn-amr3,#btn-amr4',e.target);resetAmrAssignments();amrs=[new AMR(0,COLOR_AMR[0])];manager.history=[];setupAmrGrid();runAnalysis(0);draw();});
document.getElementById('btn-amr2').addEventListener('click',e=>{setActive('#btn-amr1,#btn-amr2,#btn-amr3,#btn-amr4',e.target);resetAmrAssignments();amrs=[new AMR(0,COLOR_AMR[0]),new AMR(1,COLOR_AMR[1])];manager.history=[];setupAmrGrid();runAnalysis(0);draw();});
document.getElementById('btn-amr3').addEventListener('click',e=>{setActive('#btn-amr1,#btn-amr2,#btn-amr3,#btn-amr4',e.target);resetAmrAssignments();amrs=[new AMR(0,COLOR_AMR[0]),new AMR(1,COLOR_AMR[1]),new AMR(2,COLOR_AMR[2])];manager.history=[];setupAmrGrid();runAnalysis(0);draw();});
document.getElementById('btn-amr4').addEventListener('click',e=>{setActive('#btn-amr1,#btn-amr2,#btn-amr3,#btn-amr4',e.target);resetAmrAssignments();amrs=[new AMR(0,COLOR_AMR[0]),new AMR(1,COLOR_AMR[1]),new AMR(2,COLOR_AMR[2]),new AMR(3,COLOR_AMR[3])];manager.history=[];setupAmrGrid();runAnalysis(0);draw();});

function softReset() {
    manager.global_time = 0;
    manager.history = []; // V40: 히스토리도 초기화
    document.getElementById('prod-m3-5x').innerText='0';
    document.getElementById('prod-m3-upper').innerText='0';
    document.getElementById('prod-m3-2nd').innerText='0';
    stats = { calls: 0, totalWait: 0 };
    // V40: UI 즉시 갱신
    if (document.getElementById('val-wait')) document.getElementById('val-wait').innerText = '00:00:00';
    if (document.getElementById('clock-env')) document.getElementById('clock-env').innerText = '00:00:00';

    lastTime = null;

    ldrs.forEach((l) => {
        l.status = 'RUNNING';
        l.amr_assigned = false;
        l.elapsed_time = 0;
        l.pieces = 0;
        l.trays = 0;
        l.production_count = 0;
        l.finishing_timer = 0;
        l.done_timestamp = 0;
        l.targetTrays = eject_threshold; 
        l.cumulative_wait = 0;
        l.randomizeStart();
    });

    amrs.forEach((a, i) => {
        let bayY = 480 + (i * 1.2 * PX_PER_M);
        a.pos = {x: CHARGE_BAY_X, y: bayY};
        a.state = 'CHARGING';
        a.payload = 0;
        a.payload_model = null;
        a.payload_type = null;
        a.target_ldr = null;
        a.wait_timer = 0;
        a.target_x = CHARGE_BAY_X;
        a.target_y = bayY;
        a.evade_target = null;
        a.saved_target_x = null;
        a.saved_state = null;
        a.next_state = null;
        a.battery = a.max_battery;
        a.charge_count = 0; a.charge_counted = false;
    });
}

function resetAmrAssignments(){ ldrs.forEach(l=>l.amr_assigned=false); }

function hardReset() {
    location.reload();
}

document.getElementById('btn-soft-reset').addEventListener('click',()=>{
    softReset();
});

document.getElementById('btn-hard-reset').addEventListener('click',()=>{
    hardReset();
});

init();
requestAnimationFrame(loop);
