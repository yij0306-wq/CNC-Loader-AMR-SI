const canvas = document.getElementById('simCanvas');
const ctx = canvas.getContext('2d');

const cncImg = new Image();
cncImg.src = 'cnc_icon.png';

const WIDTH = 2800;
const HEIGHT = 750;
const NUM_LOADER = 16;

const AMR_LANE_Y = 440;
const OUTPUT_LANE_Y = 470;
const DOCKING_Y = 415; // AMR_LANE_Y(440) - 25px(650mm)
const PED_LANE_Y = 504; // 보행자 통로 간격 1000mm (39px) -> 440 + 39 + 25 = 504
const EXCLUSION_BUFFER = 200;

// U-Shape Layout Constants
const TOP_AMR_LANE_Y = 155; // AMR_LANE_Y(440) - 285px (7.3m * 39px/m)
const TOP_DOCKING_Y = 180; // TOP_AMR_LANE_Y(155) + 25px(650mm)
const VERTICAL_LANE_X = 2300;

// ===== 스케일: 중앙통로 총길이 50m = 2100px =====
const CORRIDOR_START_X = 80;
const CORRIDOR_END_X   = 2180;
const CORRIDOR_PX      = CORRIDOR_END_X - CORRIDOR_START_X; // 2100px
const CORRIDOR_M       = 53.854;   // 53.854m (사용자 요청 거리)
const PX_PER_M         = CORRIDOR_PX / CORRIDOR_M; // 38.99 px/m

const INPUT_Y = 678; // AMR_LANE_Y(440) + 238(6m)
const OUTPUT_Y = 202; // AMR_LANE_Y(440) - 238(6m)

// MULTI INPUT ZONES (원래 위치로 복구)
const INPUT_ZONES = {
    'M3 5X':    { entryX: 1697, exitX: 1667, y: INPUT_Y },
    'M3 UPPER': { entryX: 1757, exitX: 1727, y: INPUT_Y },
    'M3 2ND':   { entryX: 1817, exitX: 1787, y: INPUT_Y },
    'Min':      { entryX: 1877, exitX: 1847, y: INPUT_Y }
};

// CHARGE (오른쪽 전용 라인 및 베이)
const CHARGE_EXIT_X = 1880; // 출차 라인 (왼쪽)
const CHARGE_ENTRY_X = 1910; // 입차 라인 (오른쪽)
const CHARGE_BAY_X = 1980;   // 베이 X좌표
const CHARGE_EXIT_NODE = {x: CHARGE_EXIT_X, y: AMR_LANE_Y};
const CHARGE_ENTRY_NODE = {x: CHARGE_ENTRY_X, y: AMR_LANE_Y};

// MULTI OUTPUT ZONES (우측 수직 통로에 회전 배치)
const IO_X = 2450;
const OUTPUT_ZONES = {
    'M3 5X':    { entryY: 200, exitY: 230, x: IO_X },
    'M3 UPPER': { entryY: 260, exitY: 290, x: IO_X },
    'M3 2ND':   { entryY: 320, exitY: 350, x: IO_X },
    'Min':      { entryY: 380, exitY: 410, x: IO_X }
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
    const gap = CORRIDOR_PX / 12;
    // 로더 사이의 간격 생성
    for(let i=0; i<12; i++){
        SIDING_GAP_ORDER.push(80 + i * gap + gap/2);
    }
    // V40: 13호기 오른쪽으로 회피존 추가
    const lastLdrX = 80 + 12 * gap;
    SIDING_GAP_ORDER.push(lastLdrX + gap/2);
}
updateSidingOrder();

let extra_sidings = [];
let top_extra_sidings = [];
let evade_mode = 'BOTH'; // 기본: 회피존 모두 사용

function updateExtraSidings() {
    updateSidingOrder();
    extra_sidings = SIDING_GAP_ORDER.map(x => ({x: x, y: DOCKING_Y, type: 'EXTRA'}));
    
    const gap = CORRIDOR_PX / 12;
    top_extra_sidings = [
        {x: 80 + 12 * gap + gap/2, y: TOP_DOCKING_Y, type: 'EXTRA'},
        {x: 80 + 11 * gap + gap/2, y: TOP_DOCKING_Y, type: 'EXTRA'},
        {x: 80 + 10 * gap + gap/2, y: TOP_DOCKING_Y, type: 'EXTRA'},
        {x: 80 + 9 * gap + gap/2, y: TOP_DOCKING_Y, type: 'EXTRA'}
    ];
}
updateExtraSidings(); // 시작 시 즉시 초기화

function getEvadeCandidates(ldrs) {
    if (evade_mode === 'CNC_ONLY') return ldrs.map(l => l.x);
    if (evade_mode === 'SIDING_ONLY') return [...extra_sidings.map(s => s.x), ...top_extra_sidings.map(s => s.x)];
    return [...ldrs.map(l => l.x), ...extra_sidings.map(s => s.x), ...top_extra_sidings.map(s => s.x)];
}

const COLOR_AMR_LANE = 'rgba(249,115,22,0.15)';
const COLOR_AMR_LINE = '#ea580c';
const COLOR_PED_LANE = '#e2e8f0';
const COLOR_AMR = ['#2563eb','#10b981','#8b5cf6','#eab308'];

const MODELS = [
    {name:'M3 5X',  ct:125},
    {name:'M3 UPPER',ct:125},
    {name:'M3 2ND', ct:105},
    {name:'Min', ct:75}
];

let global_production = {'M3 5X':0,'M3 UPPER':0,'M3 2ND':0, 'Min':0};
let priority_mode = 'LOADED_YIELDS';
let eject_threshold = 8;
let use_pre_eject = false; // [변경] 초기값 비활성화
let time_scale = 1; // [변경] 초기 1배속
let is_paused = true;
let stats = { calls: 0, totalWait: 0 };
let evade_detect_range = 120;

// ★ [CorrSpeed] 중앙통로 1배속 제한 기능
// corr_speed_amr_count: 0이면 비활성, 1~4이면 해당 수 이하 id의 AMR이 중앙통로 진입 시 1배속 적용
let corr_speed_amr_count = 0; // 0 = 비활성화
const CORR_LANE_THRESHOLD = 25; // 중앙통로(AMR_LANE_Y) ±px 범위를 중앙통로로 판단

// AMR이 중앙통로를 이동 중인지 판단하는 함수
function isInCorridor(amr) {
    // Y좌표가 AMR_LANE_Y 근처(중앙통로) AND 수직 이동 상태가 아닌 경우
    const onLane = Math.abs(amr.pos.y - AMR_LANE_Y) <= CORR_LANE_THRESHOLD;
    // 수직 이동(도킹/언도킹) 중인 상태는 중앙통로 이동이 아님
    const verticalStates = ['TO_CHARGE_DOCK','FROM_CHARGE_DOCK','ENTERING_BAY','EXITING_BAY',
        'ENTERING_INPUT','EXIT_INPUT_SIDE','TO_INPUT_LANE_UP','DOCKING_IN','DOCKING_OUT',
        'TO_OUTPUT_DOCK','EXIT_OUTPUT_SIDE','FROM_OUTPUT_DOCK','EVADING_UP','EVADING_DOWN'];
    const isVertical = verticalStates.includes(amr.state);
    return onLane && !isVertical;
}

// AMR에 중앙통로 속도제한이 적용되는지 판단
function isCorrSpeedLimited(amr) {
    if (corr_speed_amr_count <= 0) return false; // 비활성
    if (amr.id >= corr_speed_amr_count) return false; // 대상 AMR 수 초과
    return isInCorridor(amr);
}

// 중앙통로 속도제한 UI 뱃지 업데이트
function updateCorrSpeedBadge() {
    const badge = document.getElementById('corr-speed-status');
    const group = document.getElementById('corrSpeedGroup');
    if (!badge || !group) return;
    if (corr_speed_amr_count > 0) {
        badge.textContent = `ON (AMR ${corr_speed_amr_count}대)`;
        badge.className = 'corr-speed-badge corr-speed-on';
        group.classList.add('active-limit');
    } else {
        badge.textContent = 'OFF';
        badge.className = 'corr-speed-badge corr-speed-off';
        group.classList.remove('active-limit');
    }
}

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
            // 가시성 개선: 대기 중일 때(DONE이면서 버퍼가 꽉 차서 진짜 대기 발생 시)와 아닐 때의 스타일 구분 강화
            if (l.status === 'DONE' && l.buffer_pieces >= 3) {
                waitBox.style.background = '#ef4444'; // 진한 빨간색 배경
                waitBox.style.color = '#ffffff';       // 흰색 글자
                waitEl.style.color = '#ffffff';
            } else if (l.cumulative_wait > 0) {
                waitBox.style.background = '#fef2f2'; // 매우 연한 붉은색 배경
                waitBox.style.color = '#ef4444';       
                waitEl.style.color = '#ef4444'; // 누적 대기시간 붉은색 강조
            } else {
                waitBox.style.background = '#f1f5f9'; // 연한 회색 배경
                waitBox.style.color = '#64748b';       // 어두운 회색 글자
                waitEl.style.color = '#1e293b';
            }
        }
    });
}

function runAnalysis(sim_dt) {
    // 글로벌 대기시간 스톱워치: 하나라도 실질적 대기 중(버퍼 3개 꽉 참)이면 증가
    let anyWaiting = ldrs.some(l => l.active && l.status === 'DONE' && l.buffer_pieces >= 3);
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
        this.totalLoadFactor = 0; // [신규] 평균 부하율 트래킹
        this.loadSamples = 0;
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
                if (window.showSimulationReport) window.showSimulationReport();
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
        if(document.getElementById('prod-min')) document.getElementById('prod-min').innerText  = global_production['Min'].toLocaleString();
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
        this.id=id; 
        this.status='RUNNING'; this.amr_assigned=false;
        if(id < 13) {
            this.x = x;
            this.y = 353;
        } else {
            const gap = CORRIDOR_PX / 12;
            if(id === 13) this.x = 80 + 12 * gap;
            else if(id === 14) this.x = 80 + 11 * gap;
            else if(id === 15) this.x = 80 + 10 * gap;
            this.y = 242;
        }
        this.elapsed_time=0; this.pieces=0; this.trays=1; // [변경] 트레이 1칸부터 시작
        this.production_count=0;
        this.finishing_timer = 0;
        this.buffer_pieces = 0; // [NEW] 대기 시 잉여 생산품을 저장할 버퍼 (최대 3개)
        if(id < 4) this.model = MODELS[0];      // 1~4: M3 5X
        else if(id < 8) this.model = MODELS[2]; // 5~8: M3 2ND
        else this.model = MODELS[1];            // 9~16: M3 UPPER
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
            
            // [변경] 호출 기준: 배출칸수(targetTrays)에 도달하면 즉시 AMR을 호출(CALLING)하여 대기시킴. (사전배출 기능 사용 시 preEjectTrays 우선)
            let callThreshold = use_pre_eject ? this.preEjectTrays : this.targetTrays;
            if(this.trays >= callThreshold && this.status === 'RUNNING'){
                this.status = 'CALLING';
            }
        } else if (this.status === 'DONE') {
            // [NEW] 버퍼 로직: DONE 상태여도 최대 3개까지 계속 가공
            if (this.buffer_pieces < 3) {
                this.elapsed_time += sim_dt;
                if (this.elapsed_time >= this.cycleTime) {
                    this.elapsed_time -= this.cycleTime;
                    this.buffer_pieces++;
                    this.production_count++;
                    global_production[this.model.name]++;
                }
            }
        } else if(this.status==='IDLE' && this.trays===0){
            this.status='RUNNING';
            this.trays = 1; // 배출 후 빈 1번 트레이 배치
        }

        // [변경] 누적 지연 시간 계산 및 히스토리 기록
        // 버퍼(최대 3개)가 꽉 찼을 때만 실질적인 대기 시간(설비 정지)으로 간주
        if(this.status === 'DONE' && this.buffer_pieces >= 3) {
            this.cumulative_wait += sim_dt;
            // stats.totalWait는 runAnalysis에서 글로벌로 통합 계산하므로 여기서 제거 (이중합산 방지)

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
        ctx.save();
        if (!this.active) {
            ctx.fillStyle='#94a3b8'; ctx.font='800 14px Inter,sans-serif';
            ctx.textAlign='center'; ctx.textBaseline='middle';
            let ty = this.id >= 13 ? TOP_AMR_LANE_Y - 60 : this.y - 45;
            ctx.fillText('LOADER-'+(this.id+1),this.x, ty);
            
            if(this.id >= 13){ ctx.translate(this.x, this.y); ctx.scale(1, -1); ctx.translate(-this.x, -this.y); }
            if (cncImg && cncImg.complete && cncImg.naturalWidth > 0) {
                ctx.drawImage(cncImg, this.x-17-65, this.y-25, 65, 55);
                ctx.drawImage(cncImg, this.x+17, this.y-25, 65, 55);
            } else {
                ctx.fillStyle='rgba(226, 232, 240, 0.8)'; ctx.strokeStyle='#94a3b8'; ctx.lineWidth=1.5;
                ctx.fillRect(this.x-17-65, this.y-25, 65, 55);
                ctx.strokeRect(this.x-17-65, this.y-25, 65, 55);
                ctx.fillRect(this.x+17, this.y-25, 65, 55);
                ctx.strokeRect(this.x+17, this.y-25, 65, 55);
            }

            ctx.fillStyle='#cbd5e1';
            ctx.beginPath(); ctx.roundRect(this.x-17,this.y-25,34,75,4); ctx.fill();
            ctx.fillStyle='#ef4444'; ctx.font='bold 12px Inter';
            ctx.fillText('OFF',this.x,this.y+10);
            ctx.restore();
            return;
        }

        // GRAPHIC DRAWING (2열은 거울 대칭)
        if(this.id >= 13){
            ctx.translate(this.x, this.y);
            ctx.scale(1, -1);
            ctx.translate(-this.x, -this.y);
        }
        
        // CNC 설비 이미지 (좌/우 약 65x55px)
        let isRunning = (this.status !== 'IDLE');
        let loaderGlow = isRunning ? (Math.abs(Math.sin(Date.now()/150)) * 15 + 5) : 0;
        
        if (cncImg && cncImg.complete && cncImg.naturalWidth > 0) {
            ctx.drawImage(cncImg, this.x-17-65, this.y-25, 65, 55);
            ctx.drawImage(cncImg, this.x+17, this.y-25, 65, 55);
        } else {
            ctx.fillStyle='rgba(248, 250, 252, 0.8)'; ctx.strokeStyle='#22c55e'; ctx.lineWidth=1.5;
            ctx.fillRect(this.x-17-65, this.y-25, 65, 55);
            ctx.strokeRect(this.x-17-65, this.y-25, 65, 55);
            ctx.fillRect(this.x+17, this.y-25, 65, 55);
            ctx.strokeRect(this.x+17, this.y-25, 65, 55);
        }

        // 75px 높이, 34px 폭(860mm) 로더 본체
        let g=ctx.createLinearGradient(this.x-17,this.y-25,this.x+17,this.y+50);
        g.addColorStop(0,'#ffffff'); g.addColorStop(1,'#e2e8f0');
        if(isRunning) { ctx.shadowColor='#22c55e'; ctx.shadowBlur=loaderGlow; }
        else { ctx.shadowColor='rgba(0,0,0,0.2)'; ctx.shadowBlur=10; }
        ctx.fillStyle=g;
        ctx.beginPath(); ctx.roundRect(this.x-17,this.y-25,34,75,4); ctx.fill();
        ctx.shadowBlur=0; ctx.strokeStyle='#cbd5e1'; ctx.lineWidth=1; ctx.stroke();
        
        // 스크린 & 상태창 (중앙)
        ctx.fillStyle='#1e293b'; ctx.fillRect(this.x-11,this.y-20,22,25);
        ctx.fillStyle='#334155'; ctx.fillRect(this.x-9,this.y-18,18,10);
        
        let led = '#2563eb'; 
        if (this.trays >= this.targetTrays) led = '#ef4444';
        else if (this.trays === this.targetTrays - 1) led = '#eab308';
        else if (this.trays === this.targetTrays - 2) led = '#22c55e';
        else if(this.status==='IDLE') led='#94a3b8';
        
        if (this.status === 'RUNNING' || this.status === 'CALLING' || this.status === 'DONE') {
            ctx.shadowColor = led; ctx.shadowBlur = (Math.abs(Math.sin(Date.now()/150)) * 15 + 8);
        }
        ctx.fillStyle=led; ctx.fillRect(this.x-8,this.y-17,16,8);
        ctx.shadowBlur = 0;
        
        // 트레이 수납부 (크기 조정)
        ctx.fillStyle='#f1f5f9'; ctx.fillRect(this.x-14,this.y+5,28,40);
        ctx.strokeStyle='rgba(148,163,184,0.5)'; ctx.strokeRect(this.x-14,this.y+5,28,40);
        
        for(let i=0;i<this.targetTrays;i++){
            let ty=this.y+39-(i*4.5);
            if(i < this.trays - 1){ 
                ctx.fillStyle='#facc15'; ctx.fillRect(this.x-10,ty,20,4); ctx.strokeStyle='#ca8a04'; ctx.strokeRect(this.x-10,ty,20,4); 
            }
            else if(i === this.trays - 1 && (this.status==='RUNNING'||this.status==='CALLING'||this.status==='DONE')){
                ctx.strokeStyle='rgba(148,163,184,0.3)'; ctx.strokeRect(this.x-10,ty,20,4);
                if(this.pieces > 0){
                    ctx.fillStyle='#fef08a'; let pw=20/this.pieces_per_tray;
                    for(let p=0;p<this.pieces;p++) ctx.fillRect(this.x-10+(p*pw),ty,pw-1,4);
                }
            }
        }
        
        // 도킹 범퍼
        ctx.fillStyle='#eab308'; ctx.beginPath(); ctx.roundRect(this.x-17,this.y+50,34,5,{bl:4,br:4}); ctx.fill();
        ctx.restore(); // 거울 대칭 복구 후 텍스트 드로잉

        // TEXT DRAWING (항상 정방향, 1열은 2열 및 CNC에 안 가려지도록 위치 세밀 조정)
        ctx.fillStyle='#0f172a'; ctx.font='900 13px Inter,sans-serif';
        ctx.textAlign='center'; ctx.textBaseline='middle';
        let textY1 = this.id >= 13 ? TOP_AMR_LANE_Y - 90 : this.y - 50;
        let textY2 = this.id >= 13 ? TOP_AMR_LANE_Y - 75 : this.y - 37;
        let textY3 = this.id >= 13 ? TOP_AMR_LANE_Y - 60 : this.y - 24;
        let textY4 = this.id >= 13 ? TOP_AMR_LANE_Y - 45 : this.y - 11;
        let textYWait = this.id >= 13 ? TOP_AMR_LANE_Y - 105 : this.y - 65;
        
        ctx.fillText('LOADER-'+(this.id+1),this.x, textY1);
        ctx.fillStyle='#2563eb'; ctx.font='bold 11px Inter';
        ctx.fillText(this.model.name,this.x, textY2);
        
        ctx.fillStyle='#475569'; ctx.font='bold 10px Inter';
        ctx.fillText('('+this.trays+'/'+this.targetTrays+'T)',this.x, textY3);
        ctx.fillStyle='#10b981'; ctx.font='bold 11px Inter';
        let currentP = (this.status === 'DONE') ? (this.targetTrays * this.pieces_per_tray) : ((this.trays - 1) * this.pieces_per_tray + this.pieces);
        let targetP = this.targetTrays * this.pieces_per_tray;
        // [변경] 누적 생산수가 아닌 현재 배치(트레이) 기준의 제품수를 표시 (48개 완료 시 0부터 재시작)
        let bufferText = this.buffer_pieces > 0 ? ` (+${this.buffer_pieces})` : '';
        ctx.fillText('생산: '+Math.max(0, currentP).toLocaleString()+'개' + bufferText, this.x, textY4);

        if (this.cumulative_wait > 0) {
            ctx.fillStyle = '#ef4444'; ctx.font = '800 12px Inter';
            ctx.fillText('대기: ' + formatTime(this.cumulative_wait), this.x, textYWait);
        }
    }
}

function getIntendedVerticalDirection(amr) {
    if (Math.abs(amr.pos.x - VERTICAL_LANE_X) < 2) {
        if (['TO_MAIN_LANE_DOWN', 'MOVING_ON_VERTICAL_TO_LANE_FROM_OUTPUT'].includes(amr.state)) return 'DOWN';
        if (['MOVING_ON_VERTICAL_FOR_OUTPUT', 'TO_INPUT_LANE', 'TO_INPUT_LANE_UP', 'TO_TOP_LANE_UP'].includes(amr.state)) return 'UP';
    }
    if (amr.target_x === VERTICAL_LANE_X) {
        if (amr.state === 'MOVING_ON_TOP_LANE') return 'DOWN';
        if (amr.state === 'MOVING_ON_LANE') {
            if (amr.next_state === 'TO_TOP_LANE_UP') return 'UP';
            if (amr.next_state === 'MOVING_ON_VERTICAL_FOR_OUTPUT') return 'UP';
        }
    }
    if (amr.state === 'EXIT_OUTPUT_SIDE') return 'DOWN';
    return null;
}

class AMR {
    constructor(id,color){
        this.id=id; this.color=color;
        // 충전 베이 위치: AMR 기본 위치(580)에서 각 1.2m 간격
        let bayY = 580 + (this.id * 1.2 * PX_PER_M);
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
        this.last_main_dir = 0; // 초기 방향 설정
        
        // [신규] 리포트용 트래킹 변수
        this.active_time = 0;
        this.idle_time = 0;
        this.charging_time = 0;
        this.traffic_wait_time = 0;
        this.total_distance = 0; // 미터(m) 단위 변환용 픽셀 누적
        this.min_soc = 100; // 최저 배터리율(%)
        this.evasion_count = 0; // 회피 발생 횟수
        this.evasion_counted = false;
        this.battery_replenished = 0; // 기회충전으로 회복된 시간(초)
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
        let dist = Math.hypot(dx, dy);

        // ★ [NEW] 실제 이동 방향(dx, dy)을 기반으로 주 통행로 회전 적용
        let onMainLane = (this.pos.y === AMR_LANE_Y) || (this.pos.y === TOP_AMR_LANE_Y) || (this.pos.x === VERTICAL_LANE_X);
        if (onMainLane && dist > 0.1) {
            // 가로 통행로
            if (this.pos.y === AMR_LANE_Y || this.pos.y === TOP_AMR_LANE_Y) {
                if (Math.abs(dx) > 0.1 && (this.state === 'MOVING_ON_LANE' || this.state === 'EVADING_TO_X' || this.state === 'MOVING_ON_TOP_LANE')) {
                    this.last_main_dir = dx > 0 ? 0 : Math.PI;
                }
            } else if (this.pos.x === VERTICAL_LANE_X) { // 세로 통행로
                if (Math.abs(dy) > 0.1 && ['MOVING_ON_VERTICAL_FOR_OUTPUT', 'TO_MAIN_LANE_DOWN', 'MOVING_ON_VERTICAL_TO_LANE_FROM_OUTPUT', 'TO_INPUT_LANE', 'TO_INPUT_LANE_UP', 'TO_TOP_LANE_UP'].includes(this.state)) {
                    this.last_main_dir = dy > 0 ? Math.PI / 2 : -Math.PI / 2;
                }
            }
        }

        let stepDist = 0;
        if(Math.abs(dx)>step) { this.pos.x+=Math.sign(dx)*step; stepDist += step; } else { stepDist += Math.abs(tx - this.pos.x); this.pos.x=tx; }
        if(Math.abs(dy)>step) { this.pos.y+=Math.sign(dy)*step; stepDist += step; } else { stepDist += Math.abs(ty - this.pos.y); this.pos.y=ty; }
        this.total_distance += stepDist;
        return (this.pos.x===tx&&this.pos.y===ty);
    }

    update(manager,amrs,ldrs,loadFactor,sim_dt){
        let step = this.pxPerSec * sim_dt; // m/s 기반 이동거리
        
        // Update battery
        if (this.state === 'CHARGING') {
            if(!this.charge_counted){ this.charge_count++; this.charge_counted = true; }
            let charged = (this.max_battery / (2 * 3600)) * sim_dt;
            this.battery += charged;
            this.battery_replenished += charged;
            if (this.battery > this.max_battery) this.battery = this.max_battery;
        } else {
            this.battery -= 1 * sim_dt;
            if (this.battery < 0) this.battery = 0;
            if (this.state !== 'CHARGING' && this.state !== 'ENTERING_BAY') this.charge_counted = false;
        }
        
        // 최저 배터리 트래킹
        let currentSoc = (this.battery / this.max_battery) * 100;
        if (currentSoc < this.min_soc) this.min_soc = currentSoc;

        // 시간 분류 트래킹 (Utilization)
        if (this.state === 'CHARGING' || this.state === 'ENTERING_BAY' || this.state === 'TO_CHARGE_DOCK' || this.state === 'EXITING_BAY' || this.state === 'FROM_CHARGE_DOCK') {
            this.charging_time += sim_dt;
        } else if (this.state === 'EVADING_WAIT' || this.state === 'EVADING_TO_X' || this.state === 'EVADING_UP' || this.state === 'EVADING_DOWN') {
            this.traffic_wait_time += sim_dt;
            if (this.state === 'EVADING_WAIT' && !this.evasion_counted) {
                this.evasion_count++;
                this.evasion_counted = true;
            }
            if (this.state !== 'EVADING_WAIT') this.evasion_counted = false;
        } else if (this.state === 'WAITING_INPUT' || (this.state === 'LOADING_WAIT' && this.wait_timer > 0)) {
            this.idle_time += sim_dt;
            this.evasion_counted = false;
        } else {
            this.active_time += sim_dt; // 이동 및 작업 시간
            this.evasion_counted = false;
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
                       
            let blocked = false;
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
                    let myL = (dual_lane && this.payload>0) ? OUTPUT_LANE_Y : AMR_LANE_Y;
                    if(Math.abs(o.pos.y - myL) < 15){
                        if(Math.abs(o.pos.x-this.pos.x)<evade_detect_range){
                            // NEW COLLISION LOGIC
                            let my_dir = Math.sign(my_tx - this.pos.x);
                            let o_dir = Math.sign(otx - o.pos.x);
                            let dist_to_o = o.pos.x - this.pos.x;
                            if (my_dir !== 0 && Math.sign(dist_to_o) === my_dir) {
                                // o is strictly in front of me
                                if (my_dir === -o_dir && o_dir !== 0) {
                                    // strict head-on
                                    conflict = true;
                                } else {
                                    // same direction, or o is stopped/moving vertically
                                    if (Math.abs(dist_to_o) < 80) blocked = true;
                                }
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
            
            if (blocked && !threat) return; // If blocked by same-direction AMR but no evasion needed, just stop

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
                } else return; // If threat but no evade zones, stop moving to prevent overlap
            }
        }

        // 세로 통행로(배출구역) 교차로 진입 대기 로직 (수직 통행로 정면 충돌 방지)
        let myIntended = getIntendedVerticalDirection(this);
        if (myIntended) {
            let myDist = Math.abs(this.pos.x - VERTICAL_LANE_X);
            if (myDist < 150) {
                let conflict = amrs.find(o => {
                    if (o.id === this.id) return false;
                    let oIntended = getIntendedVerticalDirection(o);
                    if (!oIntended) return false;
                    
                    let oDist = Math.abs(o.pos.x - VERTICAL_LANE_X);
                    if (oDist > 150) return false; // 멀리 있으면 무시
                    
                    // 방향이 반대인 경우 (정면 충돌 위협)
                    if (myIntended !== oIntended) {
                        if (oDist < 2 && myDist >= 2) return true; // 상대가 진입했으면 내가 양보
                        if (myDist < 2 && oDist >= 2) return false; // 내가 진입했으면 내가 우선
                        return o.id < this.id; // 둘 다 진입 전이거나 동시에 진입한 경우 ID 우선순위
                    } 
                    // 같은 방향인 경우 (후미 추돌 방지)
                    else {
                        if (myDist < 2 && oDist < 2) {
                            if (myIntended === 'UP' && o.pos.y < this.pos.y && (this.pos.y - o.pos.y) < 80) return true;
                            if (myIntended === 'DOWN' && o.pos.y > this.pos.y && (o.pos.y - this.pos.y) < 80) return true;
                        }
                    }
                    return false;
                });
                if (conflict) return; // 대기 (이동하지 않음)
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
                let bayY = 580 + (this.id * 1.2 * PX_PER_M);
                if(this.moveTowards(CHARGE_ENTRY_X, bayY, step)) {
                    this.state = 'ENTERING_BAY';
                }
                break;
            }
            case 'ENTERING_BAY': {
                let bayY = 580 + (this.id * 1.2 * PX_PER_M);
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
                let bayY = 580 + (this.id * 1.2 * PX_PER_M);
                // 위에서 양보 로직(교차로)은 switch문 전에 처리됨
                if(this.moveTowards(CHARGE_EXIT_X, bayY, step)) {
                    this.state = 'FROM_CHARGE_DOCK';
                }
                break;
            }
            case 'FROM_CHARGE_DOCK':
                if(this.moveTowards(CHARGE_EXIT_X, AMR_LANE_Y, step)) {
                    if(this.target_ldr) {
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
            case 'EXIT_INPUT_SIDE':
                if(this.moveTowards(getIO('IN',this.current_io_model).exitX, getIO('IN',this.current_io_model).y - 55, step)){
                    this.state = 'TO_INPUT_LANE_UP';
                }
                break;

            case 'ENTERING_INPUT': {
                let targetY = getIO('IN',this.current_io_model).y - 55;
                if(this.moveTowards(getIO('IN',this.current_io_model).entryX, targetY, step)){
                    this.state = 'AT_INPUT'; this.wait_timer = 0;
                }
                break;
            }

            case 'AT_INPUT': 
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
                        if (this.target_ldr && this.target_ldr.id >= 13) {
                            this.target_x = VERTICAL_LANE_X;
                            this.next_state = 'TO_TOP_LANE_UP';
                        } else {
                            this.target_x = this.target_ldr.x;
                            this.next_state = 'DOCKING_IN';
                        }
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
                // [변경] 수거 조건: 오직 설비가 48개 생산을 모두 완료(DONE) 했을 때만 수거 진행
                let isReady = (this.target_ldr.status === 'DONE');
                if(!isReady) return; 
                this.wait_timer += sim_dt;
                if(this.wait_timer > 30){
                    stats.calls++;
                    this.payload = this.target_ldr.trays;
                    this.payload_type = 'OUT';
                    this.target_ldr.trays = 0; 
                    // [변경] 버퍼에 모인 제품을 새 트레이(pieces)로 이관
                    this.target_ldr.pieces = this.target_ldr.buffer_pieces || 0;
                    this.target_ldr.buffer_pieces = 0; 
                    this.target_ldr.elapsed_time = 0; this.target_ldr.status = 'IDLE';
                    this.target_ldr.amr_assigned = false; this.state = 'DOCKING_OUT';
                }
                break;

            case 'DOCKING_OUT':
                let targetY = (this.target_ldr && this.target_ldr.id >= 13) ? TOP_AMR_LANE_Y : this.getTargetLaneY();
                if(this.moveTowards(this.target_ldr.x, targetY, step)){
                    if (this.target_ldr && this.target_ldr.id >= 13) {
                        this.state = 'MOVING_ON_TOP_LANE';
                        this.target_x = VERTICAL_LANE_X;
                        this.next_state = 'TO_MAIN_LANE_DOWN';
                    } else {
                        this.state='MOVING_ON_LANE';
                        this.current_io_model=this.payload_model; 
                        this.target_x=VERTICAL_LANE_X;
                        this.next_state='MOVING_ON_VERTICAL_FOR_OUTPUT';
                    }
                }
                break;
            case 'TO_TOP_LANE_UP':
                if(this.moveTowards(VERTICAL_LANE_X, TOP_AMR_LANE_Y, step)){
                    this.state='MOVING_ON_TOP_LANE';
                    this.target_x = this.target_ldr.x;
                    this.next_state = 'DOCKING_IN_ROW2';
                }
                break;
            case 'MOVING_ON_TOP_LANE':
                if(this.moveTowards(this.target_x, TOP_AMR_LANE_Y, step)){
                    this.state = this.next_state;
                }
                break;
            case 'DOCKING_IN_ROW2':
                if(this.moveTowards(this.target_ldr.x, TOP_DOCKING_Y, step)){
                    this.state='LOADING_WAIT'; this.wait_timer=0;
                }
                break;
            case 'TO_MAIN_LANE_DOWN':
                if(this.moveTowards(VERTICAL_LANE_X, this.getTargetLaneY(), step)){
                    this.state='MOVING_ON_VERTICAL_FOR_OUTPUT';
                    this.current_io_model=this.payload_model;
                }
                break;

            case 'MOVING_ON_VERTICAL_FOR_OUTPUT':
                if(this.moveTowards(VERTICAL_LANE_X, getIO('OUT',this.current_io_model).entryY, step)){
                    this.state='TO_OUTPUT_DOCK';
                }
                break;

            case 'TO_OUTPUT_DOCK':
                // 파란 박스 시작점(IO_X - 10)에 세로 상태인 AMR(폭 20) 끝단이 딱 맞게 정차 (센터 기준 -20)
                let targetX = getIO('OUT',this.current_io_model).x - 20;
                if(this.moveTowards(targetX, getIO('OUT',this.current_io_model).entryY, step)){
                    this.state='UNLOADING'; this.wait_timer=0;
                }
                break;

            case 'UNLOADING':
                this.wait_timer+=sim_dt;
                if(this.wait_timer>30){
                    this.payload=0; this.target_ldr=null;
                    this.payload_model=null; this.payload_type=null;
                    this.state='MOVE_TO_EXIT_Y_AT_DOCK';
                }
                break;
                
            case 'MOVE_TO_EXIT_Y_AT_DOCK':
                // Y축(상하)으로만 먼저 이동하여 exitY 에 도달
                if(this.moveTowards(this.pos.x, getIO('OUT',this.current_io_model).exitY, step)){
                    this.state='EXIT_OUTPUT_SIDE';
                }
                break;

            case 'EXIT_OUTPUT_SIDE':
                // Y는 이미 exitY 이므로 X축(좌우)으로만 이동하여 VERTICAL_LANE_X 에 도달
                if(this.moveTowards(VERTICAL_LANE_X, getIO('OUT',this.current_io_model).exitY, step)){
                    this.state='MOVING_ON_VERTICAL_TO_LANE_FROM_OUTPUT';
                }
                break;

            case 'MOVING_ON_VERTICAL_TO_LANE_FROM_OUTPUT':
                if(this.moveTowards(VERTICAL_LANE_X, AMR_LANE_Y, step)){
                    this.state='FROM_OUTPUT_DOCK';
                }
                break;

            case 'FROM_OUTPUT_DOCK':
                let canCharge3 = this.battery <= this.min_return_time;
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
        
        ctx.save();
        if (this.last_main_dir !== undefined) ctx.rotate(this.last_main_dir);

        // ★ [CorrSpeed] 중앙통로 1배속 제한 중인 AMR 테두리 강조
        const corrLimited = isCorrSpeedLimited(this);
        let isMoving = this.state !== 'WAITING_INPUT' && this.state !== 'CHARGING' && this.state !== 'EVADING_WAIT';
        let glowAmp = isMoving ? (Math.abs(Math.sin(Date.now()/100)) * 25 + 10) : 0;
        
        if (corrLimited) {
            ctx.shadowColor = 'rgba(6,182,212,0.6)';
            ctx.shadowBlur = 14;
        } else if (isMoving) {
            ctx.shadowColor = this.color;
            ctx.shadowBlur = glowAmp;
        } else {
            ctx.shadowColor = 'rgba(0,0,0,0.3)';
            ctx.shadowBlur = 8;
        }

        let g=ctx.createLinearGradient(-25,-10,25,10);
        g.addColorStop(0,'#f8fafc'); g.addColorStop(1,'#cbd5e1');
        ctx.fillStyle=g; ctx.beginPath(); ctx.roundRect(-25,-10,50,20,4); ctx.fill();
        ctx.shadowBlur=0;
        ctx.lineWidth = corrLimited ? 2.5 : 2;
        ctx.strokeStyle = corrLimited ? '#06b6d4' : '#475569';
        ctx.stroke();
        
        // 바퀴 및 조명 효과
        ctx.fillStyle='#0f172a'; ctx.fillRect(15,-11,10,22); ctx.fillRect(-25,-11,10,22);
        ctx.fillStyle='#3b82f6'; ctx.beginPath();
        ctx.arc(20,-6,2,0,Math.PI*2); ctx.arc(20,6,2,0,Math.PI*2);
        ctx.arc(-20,-6,2,0,Math.PI*2); ctx.arc(-20,6,2,0,Math.PI*2); ctx.fill();
        
        if (this.payload_model) {
            // 적재물 표시
            let pColor = this.payload_type==='OUT' ? '#facc15' : '#38bdf8';
            let pBorder = this.payload_type==='OUT' ? '#ca8a04' : '#0284c7';
            ctx.fillStyle=pColor; ctx.fillRect(-18,-8,36,16);
            ctx.strokeStyle=pBorder; ctx.strokeRect(-18,-8,36,16);
        } else {
            // 빈 차량 상태
            ctx.fillStyle=(this.payload===0&&this.target_ldr)?'#ec4899':this.color;
            ctx.beginPath(); ctx.roundRect(-22,-8,44,16,4); ctx.fill();
        }
        ctx.restore(); // 회전 복구하여 텍스트 정방향으로 출력

        if (this.payload_model) {
            ctx.fillStyle='#0f172a'; ctx.font='800 8px Inter';
            ctx.textAlign='center'; ctx.textBaseline='middle';
            let txt = `${this.payload_type==='IN'?'투입':'배출'}`;
            ctx.fillText(txt, -7, 0);
            ctx.font='700 7px Inter';
            ctx.fillText(this.payload_model.replace('M3 ',''), 8, 0);
        } else {
            ctx.fillStyle='#ffffff'; ctx.font='800 9px Inter';
            ctx.textAlign='center'; ctx.textBaseline='middle';
            let lbl='A'+(this.id+1);
            ctx.fillText(lbl,0,0);
        }

        // ★ [CorrSpeed] 1배속 제한 중 AMR 위에 배지 표시
        if (corrLimited) {
            ctx.fillStyle = '#06b6d4';
            ctx.beginPath(); ctx.roundRect(-10, -22, 20, 10, 3); ctx.fill();
            ctx.fillStyle = '#ffffff'; ctx.font = '800 8px Inter';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('1x', 0, -17);
        }

        if (this.state === 'CHARGING') {
            ctx.fillStyle = '#facc15';
            ctx.font = '24px Arial';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('⚡', 0, -28);
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
            <div class="loader-setting-header" style="margin-bottom:2px;">
                <span style="font-size:12px;">#${i+1}</span>
                <select style="width:65px; padding:2px; font-size:10px; margin-left:4px;" onchange="window.updateLoaderModel(${i}, this.value)">
                    ${MODELS.map(m => `<option value="${m.name}" ${l.model.name === m.name ? 'selected' : ''}>${m.name.replace('M3 ','')}</option>`).join('')}
                </select>
                <span id="st-${i}" class="${l.active ? 'status-on' : 'status-off'}" style="margin-left:auto;">${l.active ? 'ON' : 'OFF'}</span>
            </div>
            <div style="display:flex; justify-content:space-between; margin-top:2px;">
                <div style="display:flex; align-items:center; gap:2px;"><span style="color:#64748b; font-size:10px;">초/개:</span><input type="number" id="ct-input-${i}" value="${l.cycleTime}" style="width:35px; padding:1px; font-size:10px;" onchange="ldrs[${i}].cycleTime = parseInt(this.value)"></div>
                <div style="display:flex; align-items:center; gap:2px;"><span style="color:#64748b; font-size:10px;">시작:</span><input type="number" value="${l.startTrays}" min="1" max="8" style="width:30px; padding:1px; font-size:10px;" onchange="window.setLoaderStartTray(${i}, parseInt(this.value))"></div>
            </div>
            <div style="display:flex; justify-content:space-between; margin-top:2px;">
                <div style="display:flex; align-items:center; gap:2px;"><span id="pre-eject-label-${i}" style="${labelStyle} font-size:10px;">사전:</span><input type="number" value="${l.preEjectTrays}" min="1" max="9" style="width:30px; padding:1px; font-size:10px;" onchange="window.setLoaderPreEject(${i}, parseInt(this.value))"></div>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px; background:#f1f5f9; padding:2px 4px; border-radius:4px;">
                <span style="font-weight:bold; font-size:10px;">대기:</span>
                <span id="ldr-wait-${i}" style="font-weight:bold; font-size:11px; font-family:monospace;">00:00:00</span>
            </div>
            <div style="display:flex; gap:2px; margin-top:4px;">
                <button class="btn btn-toggle" style="flex:1; padding:2px; font-size:10px;" onclick="window.toggleLoader(${i})">Toggle</button>
                <button class="btn" style="flex:1; background:#6366f1; color:white; font-size:10px; padding:2px;" onclick="window.showLoaderLog(${i})">로그</button>
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
            <div class="amr-setting-header" style="margin-bottom:2px; font-size:12px;">
                <span style="color:${a.color}; font-weight:bold;">AMR #${i+1}</span>
            </div>
            <div class="amr-battery-bar-container" style="height:6px; margin-bottom:2px;">
                <div id="amr-bat-bar-${i}" class="amr-battery-bar" style="width:100%"></div>
            </div>
            <div class="amr-battery-info" id="amr-bat-text-${i}" style="font-size:10px; margin-bottom:4px;">8h 0m (100%)</div>
            <div class="amr-controls" style="font-size:10px; margin-bottom:2px;">
                <span style="color:#64748b;">속도:</span>
                <div style="display:flex; align-items:center; gap:2px;">
                    <button class="btn-small" style="padding:1px 4px; font-size:10px;" onclick="window.adjAmrSpeed(${i}, -0.1)">-</button>
                    <span id="amr-spd-${i}" style="width:35px; text-align:center;">${a.speed_mps.toFixed(1)}m/s</span>
                    <button class="btn-small" style="padding:1px 4px; font-size:10px;" onclick="window.adjAmrSpeed(${i}, 0.1)">+</button>
                </div>
            </div>
            <div class="amr-controls" style="font-size:10px;">
                <span style="color:#64748b;">복귀:</span>
                <div style="display:flex; align-items:center; gap:2px;">
                    <button class="btn-small" style="padding:1px 4px; font-size:10px;" onclick="window.adjAmrReturnTime(${i}, -1800)">-</button>
                    <span id="amr-ret-time-${i}" style="width:35px; text-align:center;">${(a.min_return_time / 3600).toFixed(1)}h</span>
                    <button class="btn-small" style="padding:1px 4px; font-size:10px;" onclick="window.adjAmrReturnTime(${i}, 1800)">+</button>
                </div>
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

window.showSimulationReport = function() {
    // 수집된 데이터 계산
    let avgLoadFactor = manager.loadSamples > 0 ? (manager.totalLoadFactor / manager.loadSamples) : 0;
    
    let totalProd = Object.values(global_production).reduce((a,b)=>a+b, 0);
    
    let sysActiveTime = 0; let sysIdleTime = 0; let sysChargeTime = 0; let sysTrafficTime = 0;
    let sysTotalDist = 0; let sysEvasionCount = 0; let sysChargeCount = 0; let minSocOverall = 100;
    
    amrs.forEach(a => {
        sysActiveTime += a.active_time;
        sysIdleTime += a.idle_time;
        sysChargeTime += a.charging_time;
        sysTrafficTime += a.traffic_wait_time;
        // px to km (1m = 38.99px, so km = px / 38.99 / 1000)
        sysTotalDist += a.total_distance / PX_PER_M / 1000;
        sysEvasionCount += a.evasion_count;
        sysChargeCount += a.charge_count;
        if (a.min_soc < minSocOverall) minSocOverall = a.min_soc;
    });

    let numAmr = amrs.length;
    let totalAmrTime = sysActiveTime + sysIdleTime + sysChargeTime + sysTrafficTime;
    let utilRate = totalAmrTime > 0 ? (sysActiveTime / totalAmrTime) * 100 : 0;
    
    let sortedLoaders = [...ldrs].filter(l => l.cumulative_wait > 0).sort((a,b) => b.cumulative_wait - a.cumulative_wait);
    
    let html = `<h2 style="margin-top:0; color:#1e293b; border-bottom:2px solid #e2e8f0; padding-bottom:10px; font-size:18px;">📊 시뮬레이션 종료 종합 리포트</h2>`;
    html += `<div style="max-height:60vh; overflow-y:auto; padding-right:10px;">`;

    // 1. 작업 처리 능력 및 물류 생산성
    html += `<div style="background:#f1f5f9; padding:12px; border-radius:6px; margin-bottom:12px;">`;
    html += `<h3 style="margin:0 0 8px 0; color:#0f172a; font-size:14px;">1. 작업 처리 능력 및 물류 생산성</h3>`;
    html += `<ul style="margin:0; padding-left:20px; font-size:13px; color:#475569; line-height:1.6;">`;
    html += `<li><strong>목표 조업 시간:</strong> ${manager.targetHours}시간</li>`;
    html += `<li><strong>시스템 평균 부하율:</strong> ${avgLoadFactor.toFixed(1)}%</li>`;
    html += `<li><strong>총 배출 수량 (Total):</strong> ${totalProd.toLocaleString()}개</li>`;
    html += `<li><strong>기종별 누적 배출량:</strong> M3 5X: <span style="color:#2563eb; font-weight:bold;">${global_production['M3 5X']}</span>개 | M3 UPPER: <span style="color:#16a34a; font-weight:bold;">${global_production['M3 UPPER']}</span>개 | M3 2ND: <span style="color:#d97706; font-weight:bold;">${global_production['M3 2ND']}</span>개 | Min: <span style="color:#ec4899; font-weight:bold;">${global_production['Min']}</span>개</li>`;
    html += `<li><strong>설비(로더) 총 다운타임:</strong> <span style="color:#ef4444; font-weight:bold;">${formatTime(stats.totalWait)}</span></li>`;
    html += `</ul>`;
    
    // 전체 로더 대기 현황 (대기 발생한 로더 전체)
    let waitingLoaders = [...ldrs].filter(l => l.cumulative_wait > 0);
    if (waitingLoaders.length > 0) {
        html += `<div style="margin-top:10px;">`;
        html += `<h4 style="margin:0 0 6px 0; color:#334155; font-size:13px;">⚠️ 설비(로더) 대기 발생 현황</h4>`;
        html += `<table style="width:100%; border-collapse:collapse; text-align:center; font-size:12px;">`;
        html += `<tr style="background:#f1f5f9; border-bottom:1px solid #cbd5e1;"><th style="padding:4px 8px;">No.</th><th style="padding:4px 8px;">로더</th><th style="padding:4px 8px;">대기 횟수</th><th style="padding:4px 8px;">누적 대기시간</th></tr>`;
        // 누적 대기시간이 가장 많은 호기부터 내림차순 정렬
        waitingLoaders.sort((a,b) => b.cumulative_wait - a.cumulative_wait).forEach((l, index) => {
            html += `<tr style="border-bottom:1px solid #e2e8f0;">
                <td style="padding:4px 8px; color:#64748b; font-weight:bold;">${index + 1}</td>
                <td style="padding:4px 8px;">LOADER-${l.id+1} (${l.model.name})</td>
                <td style="padding:4px 8px;">${l.wait_history.length}회</td>
                <td style="padding:4px 8px; color:#ef4444; font-weight:bold;">${formatTime(l.cumulative_wait)}</td>
            </tr>`;
        });
        html += `</table></div>`;
    }
    html += `</div>`;

    // 2. AMR 활용률 및 유휴 시간 분석
    html += `<div style="background:#f1f5f9; padding:12px; border-radius:6px; margin-bottom:12px;">`;
    html += `<h3 style="margin:0 0 8px 0; color:#0f172a; font-size:14px;">2. AMR 활용률 및 유휴 시간 분석</h3>`;
    let utilColor = utilRate > 95 ? '#ef4444' : (utilRate > 80 ? '#10b981' : '#f59e0b');
    html += `<p style="margin:0 0 8px 0; font-size:13px; color:#475569;"><strong>전체 평균 활용률:</strong> <span style="color:${utilColor}; font-weight:bold;">${utilRate.toFixed(1)}%</span></p>`;
    html += `<table style="width:100%; border-collapse:collapse; text-align:center; font-size:12px; background:#fff; border:1px solid #cbd5e1;">`;
    html += `<tr style="background:#e2e8f0;"><th style="padding:4px;">AMR</th><th style="padding:4px;">활성(작업)</th><th style="padding:4px;">유휴(대기)</th><th style="padding:4px;">충전소요</th></tr>`;
    amrs.forEach(a => {
        let t = a.active_time + a.idle_time + a.charging_time + a.traffic_wait_time;
        if(t===0) t=1;
        html += `<tr style="border-bottom:1px solid #f1f5f9;">
            <td style="padding:4px; font-weight:bold; color:${a.color}">#${a.id+1}</td>
            <td style="padding:4px;">${((a.active_time/t)*100).toFixed(1)}%</td>
            <td style="padding:4px;">${((a.idle_time/t)*100).toFixed(1)}%</td>
            <td style="padding:4px;">${((a.charging_time/t)*100).toFixed(1)}%</td>
        </tr>`;
    });
    html += `</table></div>`;

    // 3. 배터리 소모 및 충전 관리
    html += `<div style="background:#f1f5f9; padding:12px; border-radius:6px; margin-bottom:12px;">`;
    html += `<h3 style="margin:0 0 8px 0; color:#0f172a; font-size:14px;">3. 배터리 소모 및 충전 관리</h3>`;
    html += `<table style="width:100%; border-collapse:collapse; text-align:center; font-size:12px; background:#fff; border:1px solid #cbd5e1; margin-top:8px;">`;
    html += `<tr style="background:#e2e8f0;"><th style="padding:4px;">AMR</th><th style="padding:4px;">기회 충전 횟수</th><th style="padding:4px;">최저 배터리율</th><th style="padding:4px;">현재 잔량</th><th style="padding:4px;">현재 상태 (Status)</th></tr>`;
    amrs.forEach(a => {
        let batteryPct = ((a.battery / (8 * 3600)) * 100).toFixed(1);
        let minSocPct = a.min_soc.toFixed(1);
        let statusStr = "대기 중";
        if (a.state === 'CHARGING') statusStr = "충전 중";
        else if (a.payload > 0) statusStr = "작업 중 (적재)";
        else if (a.state === 'EVADING_WAIT') statusStr = "회피 대기 중";
        else if (a.active_time > 0 && a.target_ldr) statusStr = "이동 중 (빈 차)";
        html += `<tr style="border-bottom:1px solid #f1f5f9;">
            <td style="padding:4px; font-weight:bold; color:${a.color}">#${a.id+1}</td>
            <td style="padding:4px;">${a.charge_count}회</td>
            <td style="padding:4px; font-weight:bold; color:${a.min_soc < 20 ? '#ef4444' : '#10b981'}">${minSocPct}%</td>
            <td style="padding:4px; color:${batteryPct < 20 ? '#ef4444' : '#1e293b'}">${batteryPct}%</td>
            <td style="padding:4px;">${statusStr}</td>
        </tr>`;
    });
    html += `</table></div>`;

    // 4. 주행 트래픽 및 경로 효율성
    html += `<div style="background:#f1f5f9; padding:12px; border-radius:6px; margin-bottom:12px;">`;
    html += `<h3 style="margin:0 0 8px 0; color:#0f172a; font-size:14px;">4. 주행 트래픽 및 경로 효율성</h3>`;
    html += `<table style="width:100%; border-collapse:collapse; text-align:center; font-size:12px; background:#fff; border:1px solid #cbd5e1; margin-top:8px;">`;
    html += `<tr style="background:#e2e8f0;"><th style="padding:4px;">AMR</th><th style="padding:4px;">교착/회피 횟수</th><th style="padding:4px;">총 주행 거리</th><th style="padding:4px;">시간당 주행 거리</th></tr>`;
    amrs.forEach(a => {
        let amrDist = a.total_distance / PX_PER_M / 1000;
        let amrDistPerHour = manager.global_time > 0 ? (amrDist / (manager.global_time / 3600)).toFixed(2) : 0;
        html += `<tr style="border-bottom:1px solid #f1f5f9;">
            <td style="padding:4px; font-weight:bold; color:${a.color}">#${a.id+1}</td>
            <td style="padding:4px;">${a.evasion_count}회</td>
            <td style="padding:4px;">${amrDist.toFixed(2)} km</td>
            <td style="padding:4px;">${amrDistPerHour} km/hr</td>
        </tr>`;
    });
    html += `</table></div>`;
    


    html += `</div>`; // scroll container 끝

    document.getElementById('reportContent').innerHTML = html;
    document.getElementById('reportModal').style.display = 'flex';
};

function init(){
    manager = new SimulationManager();
    manager.speed = 1; // [변경] 기본 1배속 설정
    manager.targetHours = 10; // [변경] 기본 10시간 설정
    global_production={'M3 5X':0,'M3 UPPER':0,'M3 2ND':0, 'Min':0};
    document.getElementById('prod-m3-5x').innerText='0';
    document.getElementById('prod-m3-upper').innerText='0';
    document.getElementById('prod-m3-2nd').innerText='0';
    if(document.getElementById('prod-min')) document.getElementById('prod-min').innerText='0';
    updateExtraSidings();
    ldrs=[]; amrs=[];
    const gap = CORRIDOR_PX / 12;
    for(let i=0;i<16;i++){
        let x = 0;
        if(i < 13) x = 80 + i * gap;
        let l=new Loader(i,x); ldrs.push(l);
    }
    // 시작단 자동 배분
    let modelGroups = {};
    ldrs.forEach(l => {
        if(!modelGroups[l.model.name]) modelGroups[l.model.name] = [];
        modelGroups[l.model.name].push(l);
    });
    Object.values(modelGroups).forEach(group => {
        group.forEach((l, idx) => { l.startTrays = (idx % 8) + 1; }); // 1~8 범위 배분
    });
    
    // [NEW] 9호기(index 8)부터 16호기(index 15)까지 시작칸수: 8, 7, 6, 5, 4, 3, 2, 1
    for(let i = 8; i < 16; i++) {
        if(ldrs[i]) ldrs[i].startTrays = 16 - i;
    }
    
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
    if(btn1x) setActive('#btn-1x,#btn-5x,#btn-10x,#btn-20x,#btn-50x,#btn-100x,#btn-200x,#btn-300x', btn1x);
}

function update(dt){
    // ★ [CorrSpeed] 중앙통로에 있는 지정 AMR 수가 설정값과 일치할 때만 1배속 조건 성립
    // 예) 2대 설정 → AMR#1과 AMR#2가 동시에 중앙통로에 있어야 1배속 적용
    const corrInCount = amrs.filter(a => a.id < corr_speed_amr_count && isInCorridor(a)).length;
    const corrActive = corr_speed_amr_count > 0 && corrInCount >= corr_speed_amr_count;

    // corrActive=true 이면 sim_dt=dt(1배속), false 이면 설정 배속 그대로
    let total_sim_dt = corrActive ? dt : dt * manager.speed;
    const MAX_STEP = 0.1; // 즉시완료 모드와 완벽히 동일한 정밀도를 보장하기 위한 고정 타임스텝

    while(total_sim_dt > 0 && !manager.paused) {
        let sim_dt = Math.min(total_sim_dt, MAX_STEP);
        total_sim_dt -= sim_dt;

        manager.update(sim_dt);
        if (!manager.paused && manager.mode === 'FORWARD') {
            ldrs.forEach(l => l.update(sim_dt));          // 로더 생산 타임 동기화
            let loadFactor = runAnalysis(sim_dt);         // 분석/UI 업데이트
            manager.totalLoadFactor += loadFactor * sim_dt;
            manager.loadSamples += sim_dt;
            amrs.forEach(a => a.update(manager, amrs, ldrs, loadFactor, sim_dt)); // 모든 AMR 동기화
        } else {
            runAnalysis(0); // 정지 상태에서도 UI(배터리 등) 갱신
            if (!manager.paused && manager.mode === 'REVERSE') {
                // manager.update 내에서 rewind() 수행됨
            }
        }
    }
}

function drawEvadeHighlight(ctx,zones){
    zones.forEach(z=>{
        let dy = z.isTop ? TOP_DOCKING_Y : DOCKING_Y;
        ctx.fillStyle='rgba(124,58,237,0.07)';
        ctx.fillRect(z.x-30, dy-25, 60, 50);
        ctx.strokeStyle='rgba(124,58,237,0.30)'; ctx.lineWidth=1.5;
        ctx.setLineDash([5,4]); ctx.strokeRect(z.x-30, dy-25, 60, 50); ctx.setLineDash([]);
    });

    // 추가 회피존 표시 (SIDING)
    extra_sidings.forEach((s,i)=>{
        ctx.fillStyle='rgba(250,204,21,0.2)';
        ctx.fillRect(s.x-25, AMR_LANE_Y-20, 50, 40);
        ctx.strokeStyle='rgba(250,204,21,0.5)';
        ctx.strokeRect(s.x-25, AMR_LANE_Y-20, 50, 40);
    });

    // 2열(상단) 회피존 표시
    top_extra_sidings.forEach((s,i)=>{
        ctx.fillStyle='rgba(250,204,21,0.2)';
        ctx.fillRect(s.x-25, TOP_AMR_LANE_Y-20, 50, 40);
        ctx.strokeStyle='rgba(250,204,21,0.5)';
        ctx.strokeRect(s.x-25, TOP_AMR_LANE_Y-20, 50, 40);
    });
}

function draw(){
    ctx.clearRect(0,0,WIDTH,HEIGHT);

    // 보행자 통로 동적 Y 계산: AMR 주 통행로 하단 가장자리 라인(bottom edge)과 맞닿도록
    let amr_bottom_edge = dual_lane ? (OUTPUT_LANE_Y + 15) : (AMR_LANE_Y + 14);
    let dynamic_ped_lane_top = amr_bottom_edge;
    let dynamic_ped_lane_y = dynamic_ped_lane_top + 25; // 중앙 y좌표

    // 보행자 레인
    ctx.fillStyle=COLOR_PED_LANE; ctx.fillRect(0,dynamic_ped_lane_y-25,VERTICAL_LANE_X+14,50);
    ctx.fillStyle='#64748b'; ctx.font='800 14px Inter'; ctx.textAlign='left';
    ctx.fillText('보행자',20,dynamic_ped_lane_y+5);

    let dashOffset = -(Date.now() / 30) % 100;

    // 배출(OUTPUT) 2라인 표시
    if(dual_lane){
        ctx.fillStyle='rgba(59,130,246,0.1)'; ctx.fillRect(0,OUTPUT_LANE_Y-15,WIDTH,30);
        ctx.beginPath(); ctx.moveTo(0,OUTPUT_LANE_Y); ctx.lineTo(WIDTH,OUTPUT_LANE_Y);
        ctx.strokeStyle='#3b82f6'; ctx.lineWidth=2; ctx.setLineDash([8,4]); ctx.lineDashOffset = dashOffset; ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset=0;
        ctx.fillStyle='#3b82f6'; ctx.font='800 12px Inter'; ctx.textAlign='left';
        ctx.fillText('배출 경로 (2라인)',20,OUTPUT_LANE_Y+12);
    }

    // 투입 레인
    ctx.fillStyle=COLOR_AMR_LANE;
    let lh=dual_lane?(OUTPUT_LANE_Y-AMR_LANE_Y+29):28; // 폭 700mm = 28px
    ctx.fillRect(0,AMR_LANE_Y-14,VERTICAL_LANE_X+14,lh);
    ctx.beginPath(); ctx.moveTo(0,AMR_LANE_Y); ctx.lineTo(VERTICAL_LANE_X+14,AMR_LANE_Y);
    ctx.strokeStyle=COLOR_AMR_LINE; ctx.lineWidth=2; ctx.setLineDash([15,10]); ctx.lineDashOffset = dashOffset; ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset=0;
    ctx.fillStyle=COLOR_AMR_LINE; ctx.font='800 12px Inter'; ctx.textAlign='left';
    ctx.fillText(dual_lane?'투입 경로 (1라인)':'AMR',20,AMR_LANE_Y-18);

    // 회피구간 하이라이트
    let evZones=[];
    if(evade_mode==='CNC_ONLY') evZones=ldrs.map(l=>({x:l.x, isTop: l.id>=13}));
    else if(evade_mode==='SIDING_ONLY') evZones=[...extra_sidings.map(s=>({x:s.x, isTop:false})), ...top_extra_sidings.map(s=>({x:s.x, isTop:true}))];
    else evZones=[...ldrs.map(l=>({x:l.x, isTop: l.id>=13})), ...extra_sidings.map(s=>({x:s.x, isTop:false})), ...top_extra_sidings.map(s=>({x:s.x, isTop:true}))];
    drawEvadeHighlight(ctx,evZones);

    // 로더 도킹 라인 (위쪽/아래쪽)
    function drawDockUp(x, isTop){
        let laneY = isTop ? TOP_AMR_LANE_Y : AMR_LANE_Y;
        let dockY = isTop ? TOP_DOCKING_Y : DOCKING_Y;
        let sign = isTop ? -1 : 1;
        ctx.strokeStyle='rgba(234,88,12,0.4)'; ctx.lineWidth=2; ctx.setLineDash([5,5]); ctx.lineDashOffset = dashOffset;
        ctx.beginPath(); ctx.moveTo(x,laneY); ctx.lineTo(x,dockY); ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
        ctx.beginPath();
        ctx.moveTo(x-30,laneY - 10*sign); ctx.lineTo(x-30,dockY - 20*sign);
        ctx.lineTo(x+30,dockY - 20*sign); ctx.lineTo(x+30,laneY - 10*sign); ctx.stroke();
    }
    ldrs.forEach(l=>drawDockUp(l.x, l.id >= 13));
    
    // Draw TOP AMR LANE and VERTICAL LANE
    ctx.fillStyle=COLOR_AMR_LANE; ctx.fillRect(0, TOP_AMR_LANE_Y-14, VERTICAL_LANE_X+14, 28);
    ctx.fillRect(VERTICAL_LANE_X-14, TOP_AMR_LANE_Y-14, 28, AMR_LANE_Y-TOP_AMR_LANE_Y+28);
    ctx.strokeStyle=COLOR_AMR_LINE; ctx.lineWidth=2; ctx.setLineDash([15,10]); ctx.lineDashOffset = dashOffset;
    ctx.beginPath(); ctx.moveTo(0, TOP_AMR_LANE_Y); ctx.lineTo(VERTICAL_LANE_X, TOP_AMR_LANE_Y); ctx.lineTo(VERTICAL_LANE_X, AMR_LANE_Y); ctx.stroke();
    ctx.setLineDash([]); ctx.lineDashOffset = 0;

    // 추가 회피존 도킹 라인 표시 (SIDING)
    extra_sidings.forEach(s=>{
        drawDockUp(s.x, false);
    });
    
    // 2열 회피존 도킹 라인 표시
    top_extra_sidings.forEach(s=>{
        drawDockUp(s.x, true);
    });

        // ===== MULTI INPUT ZONES =====
    Object.values(INPUT_ZONES).forEach((zone, i) => {
        let ix=zone.entryX, iy=zone.y;
        let iEntX=zone.entryX, iExX=zone.exitX;
        let iLaneY=dual_lane?OUTPUT_LANE_Y:AMR_LANE_Y;
        let modelNames = ['M3 5X', 'M3 UPPER', 'M3 2ND', 'Min'];
        
        ctx.strokeStyle='rgba(234,88,12,0.6)'; ctx.lineWidth=2; ctx.setLineDash([5,5]); ctx.lineDashOffset = dashOffset;
        ctx.beginPath(); ctx.moveTo(iEntX,iLaneY); ctx.lineTo(iEntX,iy-45); ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
        ctx.strokeStyle='rgba(16,185,129,0.6)'; ctx.lineWidth=2; ctx.setLineDash([5,5]); ctx.lineDashOffset = dashOffset;
        ctx.beginPath(); ctx.moveTo(iExX,iLaneY); ctx.lineTo(iExX,iy-45); ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
        ctx.strokeStyle='rgba(234,88,12,0.4)'; ctx.lineWidth=2;
        ctx.beginPath();
        ctx.moveTo(iExX-10,iLaneY+10); ctx.lineTo(iExX-10,iy-45);
        ctx.lineTo(iEntX+10,iy-45); ctx.lineTo(iEntX+10,iLaneY+10); ctx.stroke();
        
        ctx.fillStyle='rgba(234,88,12,0.8)'; ctx.font='bold 9px Inter'; ctx.textAlign='center';
        ctx.fillText('▼입차',iEntX,iLaneY+14);
        ctx.fillStyle='rgba(16,185,129,0.9)';
        ctx.fillText('▲출차',iExX,iLaneY+14);
        
        let isDocking = amrs.some(a => a.pos.x >= iExX - 5 && a.pos.x <= iEntX + 5 && a.pos.y > AMR_LANE_Y + 10);
        if(isDocking) {
            ctx.shadowColor = 'rgba(16,185,129,1)'; ctx.shadowBlur = (Math.abs(Math.sin(Date.now()/100)) * 20 + 10);
        } else {
            ctx.shadowColor='rgba(0,0,0,0.1)'; ctx.shadowBlur=5;
        }
        ctx.fillStyle='#fde68a';
        ctx.beginPath(); ctx.roundRect(iExX-15,iy-45,iEntX-iExX+30,90,12); ctx.fill();
        ctx.shadowBlur=0; ctx.strokeStyle='#334155'; ctx.lineWidth=2; ctx.stroke();
        ctx.fillStyle='#0f172a'; ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.font='700 11px Inter'; ctx.fillText('IN ' + modelNames[i].replace('M3 ',''),(iEntX+iExX)/2,iy);
    });
// ===== CHARGE 전용 라인 및 베이 (4칸) =====
    let cExX = CHARGE_EXIT_X, cEntX = CHARGE_ENTRY_X;
    ctx.strokeStyle='rgba(16,185,129,0.6)'; ctx.lineWidth=2; ctx.setLineDash([5,5]); ctx.lineDashOffset = dashOffset;
    ctx.beginPath(); ctx.moveTo(cExX, AMR_LANE_Y); ctx.lineTo(cExX, 700); ctx.stroke();
    ctx.strokeStyle='rgba(234,88,12,0.6)';
    ctx.beginPath(); ctx.moveTo(cEntX, AMR_LANE_Y); ctx.lineTo(cEntX, 700); ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
    ctx.fillStyle='rgba(16,185,129,0.9)'; ctx.font='bold 10px Inter'; ctx.textAlign='center';
    ctx.fillText('▲출차', cExX, AMR_LANE_Y+14);
    ctx.fillStyle='rgba(234,88,12,0.9)';
    ctx.fillText('▼입차', cEntX, AMR_LANE_Y+14);

    for (let i = 0; i < 4; i++) {
        let bayY = 580 + (i * 1.2 * PX_PER_M);
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
        let ox=zone.x, oEntY=zone.entryY, oExY=zone.exitY;
        let modelNames = ['M3 5X', 'M3 UPPER', 'M3 2ND', 'Min'];

        ctx.strokeStyle='rgba(59,130,246,0.6)'; ctx.lineWidth=2; ctx.setLineDash([5,5]); ctx.lineDashOffset = dashOffset;
        ctx.beginPath(); ctx.moveTo(VERTICAL_LANE_X,oEntY); ctx.lineTo(ox-30,oEntY); ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
        ctx.strokeStyle='rgba(139,92,246,0.6)'; ctx.lineWidth=2; ctx.setLineDash([5,5]); ctx.lineDashOffset = dashOffset;
        ctx.beginPath(); ctx.moveTo(VERTICAL_LANE_X,oExY); ctx.lineTo(ox-30,oExY); ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
        
        ctx.strokeStyle='rgba(59,130,246,0.4)'; ctx.lineWidth=2;
        ctx.beginPath();
        ctx.moveTo(ox-30, oEntY-10); ctx.lineTo(ox-10, oEntY-10);
        ctx.lineTo(ox-10, oExY+10); ctx.lineTo(ox-30, oExY+10); ctx.stroke();
        
        ctx.fillStyle='rgba(59,130,246,0.9)'; ctx.font='bold 9px Inter'; ctx.textAlign='center';
        ctx.fillText('▶입차', VERTICAL_LANE_X+15, oEntY-4);
        ctx.fillStyle='rgba(139,92,246,0.9)';
        ctx.fillText('◀출차', VERTICAL_LANE_X+15, oExY-4);
        
        let isDocking = amrs.some(a => (a.state === 'UNLOADING' || a.state === 'TO_OUTPUT_DOCK') && Math.abs(a.pos.y - oEntY) < 20);
        if(isDocking) {
            ctx.shadowColor = 'rgba(139,92,246,1)'; ctx.shadowBlur = (Math.abs(Math.sin(Date.now()/100)) * 20 + 10);
        } else {
            ctx.shadowColor='rgba(0,0,0,0.1)'; ctx.shadowBlur=5;
        }
        ctx.fillStyle='#bfdbfe';
        ctx.beginPath(); ctx.roundRect(ox-10, oEntY-15, 90, oExY-oEntY+30, 12); ctx.fill();
        ctx.shadowBlur=0; ctx.strokeStyle='#334155'; ctx.lineWidth=2; ctx.stroke();
        ctx.fillStyle='#0f172a'; ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.font='700 11px Inter'; ctx.fillText('OUT ' + modelNames[i].replace('M3 ',''), ox+35, (oEntY+oExY)/2);
    });
    
    // [NEW] 1열 1~10호기(인덱스 0~9) 상단(2열 위치)에 빈 CNC 사각 박스 그리기
    for(let i=0; i<10; i++) {
        let x = ldrs[i].x;
        let y = 242; // Row 2 Loader Y coordinate
        ctx.save();
        ctx.translate(x, y); ctx.scale(1, -1); ctx.translate(-x, -y);
        ctx.fillStyle='rgba(248, 250, 252, 0.8)'; ctx.strokeStyle='#22c55e'; ctx.lineWidth=1.5;
        // 좌측 CNC
        if (cncImg && cncImg.complete && cncImg.naturalWidth > 0) {
            ctx.drawImage(cncImg, x-17-65, y-25, 65, 55);
            ctx.drawImage(cncImg, x+17, y-25, 65, 55);
        } else {
            ctx.fillRect(x-17-65, y-25, 65, 55); ctx.strokeRect(x-17-65, y-25, 65, 55);
            ctx.fillRect(x+17, y-25, 65, 55); ctx.strokeRect(x+17, y-25, 65, 55);
        }
        ctx.restore();
    }

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
document.getElementById('btn-1x').addEventListener('click',e=>{manager.speed=1;setActive('#btn-1x,#btn-5x,#btn-10x,#btn-20x,#btn-50x,#btn-100x,#btn-200x,#btn-300x',e.target);});
document.getElementById('btn-5x').addEventListener('click',e=>{manager.speed=5;setActive('#btn-1x,#btn-5x,#btn-10x,#btn-20x,#btn-50x,#btn-100x,#btn-200x,#btn-300x',e.target);});
document.getElementById('btn-10x').addEventListener('click',e=>{manager.speed=10;setActive('#btn-1x,#btn-5x,#btn-10x,#btn-20x,#btn-50x,#btn-100x,#btn-200x,#btn-300x',e.target);});
document.getElementById('btn-20x').addEventListener('click',e=>{manager.speed=20;setActive('#btn-1x,#btn-5x,#btn-10x,#btn-20x,#btn-50x,#btn-100x,#btn-200x,#btn-300x',e.target);});
document.getElementById('btn-50x').addEventListener('click',e=>{manager.speed=50;setActive('#btn-1x,#btn-5x,#btn-10x,#btn-20x,#btn-50x,#btn-100x,#btn-200x,#btn-300x',e.target);});
document.getElementById('btn-100x').addEventListener('click',e=>{manager.speed=100;setActive('#btn-1x,#btn-5x,#btn-10x,#btn-20x,#btn-50x,#btn-100x,#btn-200x,#btn-300x',e.target);});
document.getElementById('btn-200x').addEventListener('click',e=>{manager.speed=200;setActive('#btn-1x,#btn-5x,#btn-10x,#btn-20x,#btn-50x,#btn-100x,#btn-200x,#btn-300x',e.target);});
document.getElementById('btn-300x').addEventListener('click',e=>{manager.speed=300;setActive('#btn-1x,#btn-5x,#btn-10x,#btn-20x,#btn-50x,#btn-100x,#btn-200x,#btn-300x',e.target);});

// [NEW] 조업 목표 시간 설정 리스너
document.getElementById('select-target-time').addEventListener('change', e => {
    manager.targetHours = parseInt(e.target.value);
});

// ★ [CorrSpeed] 중앙통로 1배속 AMR 수 설정 리스너
document.getElementById('input-corr-amr-count').addEventListener('change', e => {
    let val = parseInt(e.target.value);
    if (isNaN(val) || val < 0) val = 0;
    if (val > 4) val = 4;
    corr_speed_amr_count = val;
    e.target.value = val;
    updateCorrSpeedBadge();
});
document.getElementById('input-corr-amr-count').addEventListener('input', e => {
    let val = parseInt(e.target.value);
    if (isNaN(val) || val < 0) val = 0;
    if (val > 4) val = 4;
    corr_speed_amr_count = val;
    updateCorrSpeedBadge();
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

document.getElementById('btn-amr1').addEventListener('click',e=>{setActive('#btn-amr1,#btn-amr2,#btn-amr3,#btn-amr4',e.target);resetAmrAssignments();amrs=[new AMR(0,COLOR_AMR[0])];softReset();setupAmrGrid();draw();});
document.getElementById('btn-amr2').addEventListener('click',e=>{setActive('#btn-amr1,#btn-amr2,#btn-amr3,#btn-amr4',e.target);resetAmrAssignments();amrs=[new AMR(0,COLOR_AMR[0]),new AMR(1,COLOR_AMR[1])];softReset();setupAmrGrid();draw();});
document.getElementById('btn-amr3').addEventListener('click',e=>{setActive('#btn-amr1,#btn-amr2,#btn-amr3,#btn-amr4',e.target);resetAmrAssignments();amrs=[new AMR(0,COLOR_AMR[0]),new AMR(1,COLOR_AMR[1]),new AMR(2,COLOR_AMR[2])];softReset();setupAmrGrid();draw();});
document.getElementById('btn-amr4').addEventListener('click',e=>{setActive('#btn-amr1,#btn-amr2,#btn-amr3,#btn-amr4',e.target);resetAmrAssignments();amrs=[new AMR(0,COLOR_AMR[0]),new AMR(1,COLOR_AMR[1]),new AMR(2,COLOR_AMR[2]),new AMR(3,COLOR_AMR[3])];softReset();setupAmrGrid();draw();});

function softReset() {
    manager.global_time = 0;
    manager.history = []; // V40: 히스토리도 초기화
    manager.totalLoadFactor = 0;
    manager.loadSamples = 0;
    global_production={'M3 5X':0,'M3 UPPER':0,'M3 2ND':0, 'Min':0};
    document.getElementById('prod-m3-5x').innerText='0';
    document.getElementById('prod-m3-upper').innerText='0';
    document.getElementById('prod-m3-2nd').innerText='0';
    if(document.getElementById('prod-min')) document.getElementById('prod-min').innerText='0';
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
        l.wait_history = [];
        l.current_wait_event = null;
        l.randomizeStart();
    });

    amrs.forEach((a, i) => {
        let bayY = 580 + (i * 1.2 * PX_PER_M);
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

    manager.paused = true;
    const btnPause = document.getElementById('btn-pause');
    if(btnPause) setActive('#btn-pause,#btn-start,#btn-backward', btnPause);
    
    runAnalysis(0);
}

function resetAmrAssignments(){ ldrs.forEach(l=>l.amr_assigned=false); }

function hardReset() {
    location.reload();
}

document.getElementById('btn-apply-min-all').addEventListener('click', () => {
    ldrs.forEach((l, i) => {
        if(l.active) {
            window.updateLoaderModel(i, 'Min');
        }
    });
    if (typeof setupLoaderGrid === 'function') {
        setupLoaderGrid();
    }
});

document.getElementById('btn-soft-reset').addEventListener('click',()=>{
    softReset();
});

document.getElementById('btn-hard-reset').addEventListener('click',()=>{
    hardReset();
});

document.getElementById('btn-instant-complete').addEventListener('click', (e) => {
    if (manager.targetHours <= 0) {
        alert("조업 목표 시간이 '사용 안함'으로 설정되어 있습니다. 시간을 선택해주세요.");
        return;
    }
    
    // UI 반영
    manager.paused = false;
    manager.mode = 'FORWARD';
    const btnPause = document.getElementById('btn-pause');
    if (btnPause) {
        document.querySelectorAll('#btn-pause,#btn-start,#btn-backward').forEach(b=>b.classList.remove('active'));
        document.getElementById('btn-start').classList.add('active');
    }
    
    const targetSecs = manager.targetHours * 3600;
    const btn = e.target;
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.style.opacity = '0.8';
    
    // 강제 1배속 설정 및 비동기 분할 연산 (Chunking)
    function processChunk() {
        if (manager.paused) {
            btn.innerHTML = originalText;
            btn.disabled = false;
            btn.style.opacity = '1';
            return;
        }
        
        // 1시간 분량(3600초)을 한 프레임에 연산 (JS 성능상 충분히 빠르지만 멈춤을 방지)
        let chunkEnd = manager.global_time + 3600;
        let limit = Math.min(chunkEnd, targetSecs);
        
        // ★ 핵심: 즉시 완료 시뮬레이션 중에는 1배속 강제 고정하여 정밀도 보장
        manager.speed = 1;
        
        while(manager.global_time < limit && !manager.paused) {
            // 내부 시간 가속은 0.1초 단위 고정
            update(0.1);
        }
        
        let percent = ((manager.global_time / targetSecs) * 100).toFixed(1);
        btn.innerText = `⚡ ${percent}% 완료...`;
        
        if (manager.global_time < targetSecs) {
            // 화면(진행률) 렌더링 후 다음 Chunk 연산 재개
            requestAnimationFrame(processChunk);
        } else {
            btn.innerHTML = originalText;
            btn.disabled = false;
            btn.style.opacity = '1';
            draw(); // 최종 렌더링 1회 수행
        }
    }
    
    processChunk();
});

init();
requestAnimationFrame(loop);
