const canvas = document.getElementById('simCanvas');
const ctx = canvas.getContext('2d');

const WIDTH = 2600;
const HEIGHT = 750;
const NUM_LOADER = 16;

const AMR_LANE_Y = 340;
const OUTPUT_LANE_Y = 370;
const DOCKING_Y = 250;
const PED_LANE_Y = 410;
const EXCLUSION_BUFFER = 200;

// INPUT (y=650)
const INPUT_ENTRY_X = 2200;
const INPUT_EXIT_X  = 2170;
const INPUT_ZONE  = {x: INPUT_ENTRY_X, y: 650};
const INPUT_ENTRY_NODE = {x: INPUT_ENTRY_X, y: AMR_LANE_Y};
const INPUT_EXIT_NODE  = {x: INPUT_EXIT_X,  y: AMR_LANE_Y};

// CHARGE (오른쪽 전용 라인 및 베이)
const CHARGE_EXIT_X = 2260; // 출차 라인 (왼쪽)
const CHARGE_ENTRY_X = 2290; // 입차 라인 (오른쪽)
const CHARGE_BAY_X = 2360;   // 베이 X좌표
const CHARGE_EXIT_NODE = {x: CHARGE_EXIT_X, y: AMR_LANE_Y};
const CHARGE_ENTRY_NODE = {x: CHARGE_ENTRY_X, y: AMR_LANE_Y};

// OUTPUT
const OUTPUT_ENTRY_X = 2440;
const OUTPUT_EXIT_X  = 2470;
const OUTPUT_ZONE  = {x: OUTPUT_ENTRY_X, y: 150};
const OUTPUT_ENTRY_NODE = {x: OUTPUT_ENTRY_X, y: AMR_LANE_Y};
const OUTPUT_EXIT_NODE  = {x: OUTPUT_EXIT_X,  y: AMR_LANE_Y};

let dual_lane = false;

// Generate siding gaps dynamically for 16 loaders + 1 extra at the end
const SIDING_GAP_ORDER = Array.from({length: NUM_LOADER}, (_, i) => 80 + i * 130 + 65);

let extra_sidings = [];
let evade_mode = 'CNC_ONLY';

function updateExtraSidings() {
    extra_sidings = SIDING_GAP_ORDER.map(x => ({x: x, y: DOCKING_Y, type: 'EXTRA'}));
}

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
    {name:'M3 5X',  ct:145},
    {name:'M3 UPPER',ct:145},
    {name:'M3 2ND', ct:120}
];

let global_production = {'M3 5X':0,'M3 UPPER':0,'M3 2ND':0};
let priority_mode = 'LOADED_YIELDS';
let call_mode = '8_MAX';
let custom_call_threshold = 5;
let stats = { calls: 0, totalWait: 0 };

function runAnalysis() {
    // 글로벌 대기시간 스톱워치: 하나라도 대기 중이면 증가
    let anyWaiting = ldrs.some(l => l.active && l.status === 'DONE' && !l.amr_assigned);
    if (anyWaiting && manager.speed > 0) {
        stats.totalWait += manager.speed * (1/60);
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
    
    document.getElementById('val-load').innerText = `${loadFactor}%`;
    document.getElementById('val-wait').innerText = `${Math.floor(stats.totalWait)}s`;
    
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
    constructor(){ this.speed=1; this.global_time=0; }
    update(){
        this.global_time += this.speed;
        document.getElementById('prod-m3-5x').innerText   = global_production['M3 5X'].toLocaleString();
        document.getElementById('prod-m3-upper').innerText = global_production['M3 UPPER'].toLocaleString();
        document.getElementById('prod-m3-2nd').innerText  = global_production['M3 2ND'].toLocaleString();
    }
}

class Loader {
    constructor(id,x){
        this.id=id; this.x=x; this.y=170;
        this.status='RUNNING'; this.amr_assigned=false;
        this.elapsed_time=0; this.pieces=0; this.trays=0; this.production_count=0;
        this.finishing_timer = 0;
        if(id<5) this.model=MODELS[0];
        else if(id<11) this.model=MODELS[1];
        else this.model=MODELS[2];
        this.targetTrays=8; this.pieces_per_tray=6;
        this.active = true;
        this.cycleTime = this.model.ct;
    }
    randomizeStart(){
        this.trays=this.id%6; this.pieces=0;
        this.elapsed_time=(this.id*50)%this.cycleTime;
        this.production_count=(this.trays*this.pieces_per_tray)+this.pieces;
        global_production[this.model.name]+=this.production_count;
    }
    update(speed){
        if (!this.active) return;
        
        if(this.status==='RUNNING'||this.status==='CALLING'){
            this.elapsed_time+=speed;
            if(this.elapsed_time>=this.cycleTime){
                this.elapsed_time-=this.cycleTime;
                this.pieces++; this.production_count++;
                global_production[this.model.name]++;
                if(this.pieces>=this.pieces_per_tray){this.pieces=0;this.trays++;}
            }
            
            let trigger_call = false;
            if(call_mode === '8_MAX' && this.trays >= this.targetTrays - 1) trigger_call = true;
            else if(call_mode === 'CUSTOM' && this.trays >= custom_call_threshold) trigger_call = true;
            
            if(trigger_call && this.status !== 'CALLING') this.status = 'CALLING';
            
            if(this.trays>=this.targetTrays){
                this.trays=this.targetTrays;
                this.pieces=0;
                this.status='FINISHING';
                this.finishing_timer=0;
            }
        } else if(this.status==='FINISHING'){
            // 완료 지연 로직 (1 트레이 가공시간 대기)
            this.finishing_timer += speed;
            if (this.finishing_timer >= (this.cycleTime * this.pieces_per_tray)) {
                this.status = 'DONE';
            }
        } else if(this.status==='IDLE'&&this.trays===0&&this.pieces===0){
            this.status='RUNNING';
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
        ctx.fillText('LOADER-'+(this.id+1),this.x,this.y-75);
        ctx.fillStyle='#2563eb'; ctx.font='bold 12px Inter';
        ctx.fillText(this.model.name,this.x,this.y-60);
        let g=ctx.createLinearGradient(this.x-35,this.y-40,this.x+35,this.y+50);
        g.addColorStop(0,'#ffffff'); g.addColorStop(1,'#e2e8f0');
        ctx.shadowColor='rgba(0,0,0,0.2)'; ctx.shadowBlur=10; ctx.fillStyle=g;
        ctx.beginPath(); ctx.roundRect(this.x-38,this.y-45,76,100,6); ctx.fill();
        ctx.shadowBlur=0; ctx.strokeStyle='#cbd5e1'; ctx.lineWidth=1; ctx.stroke();
        ctx.fillStyle='#1e293b'; ctx.fillRect(this.x+10,this.y-35,22,35);
        ctx.fillStyle='#334155'; ctx.fillRect(this.x+12,this.y-33,18,15);
        
        let blink=Math.floor(gt/30)%2===0;
        let led='#22c55e';
        if(this.status==='DONE') led='#ef4444';
        else if(this.status==='FINISHING') led='#f59e0b';
        else if(this.status==='CALLING') led=this.amr_assigned?(blink?'#3b82f6':'#1e3a8a'):(blink?'#f97316':'#9a3412');
        else if(this.status==='IDLE') led='#94a3b8';
        ctx.fillStyle=led; ctx.fillRect(this.x+13,this.y-32,16,13);
        ctx.fillStyle='#f1f5f9'; ctx.fillRect(this.x-32,this.y-15,64,60);
        ctx.strokeStyle='rgba(148,163,184,0.5)'; ctx.strokeRect(this.x-32,this.y-15,64,60);
        
        for(let i=0;i<this.targetTrays;i++){
            let ty=this.y+35-(i*7);
            if(i<this.trays){ ctx.fillStyle='#facc15'; ctx.fillRect(this.x-22,ty,44,6); ctx.strokeStyle='#ca8a04'; ctx.strokeRect(this.x-22,ty,44,6); }
            else if(i===this.trays&&(this.status==='RUNNING'||this.status==='CALLING')&&this.pieces>0){
                ctx.fillStyle='#fef08a'; let pw=44/this.pieces_per_tray;
                for(let p=0;p<this.pieces;p++) ctx.fillRect(this.x-22+(p*pw),ty,pw-1,6);
            }
        }
        ctx.fillStyle='#eab308'; ctx.beginPath(); ctx.roundRect(this.x-38,this.y+50,76,5,{bl:6,br:6}); ctx.fill();
        ctx.fillStyle='#64748b'; ctx.font='bold 11px Inter';
        ctx.fillText('('+this.trays+'/'+this.targetTrays+'T)',this.x,this.y+70);
        ctx.fillStyle='#10b981'; ctx.font='bold 12px Inter';
        ctx.fillText('생산: '+this.production_count.toLocaleString()+'개',this.x,this.y+90);
    }
}

class AMR {
    constructor(id,color){
        this.id=id; this.color=color;
        this.pos={...INPUT_ZONE};
        this.state='WAITING_INPUT'; this.speed=3; this.payload=0;
        this.target_ldr=null; this.wait_timer=0;
        this.target_x=this.pos.x; this.target_y=this.pos.y;
        this.evade_target=null; this.saved_target_x=null; this.saved_state=null;
        this.next_state=null;
        
        // Battery (in seconds of simulation time)
        this.max_battery = 8 * 60 * 60; // 8 hours
        this.battery = this.max_battery;
        this.min_return_time = 1.5 * 60 * 60; // 1.5 hours
    }

    getTargetLaneY(){ return (dual_lane&&this.payload>0)?OUTPUT_LANE_Y:AMR_LANE_Y; }

    moveTowards(tx,ty,step){
        let dx=tx-this.pos.x, dy=ty-this.pos.y;
        if(Math.abs(dx)>step) this.pos.x+=Math.sign(dx)*step; else this.pos.x=tx;
        if(Math.abs(dy)>step) this.pos.y+=Math.sign(dy)*step; else this.pos.y=ty;
        return (this.pos.x===tx&&this.pos.y===ty);
    }

    update(manager,amrs,ldrs,loadFactor){
        let step=this.speed*manager.speed;
        
        // Update battery
        if (this.state === 'CHARGING') {
            this.battery += (this.max_battery / (2 * 3600)) * manager.speed;
            if (this.battery > this.max_battery) this.battery = this.max_battery;
        } else {
            this.battery -= 1 * manager.speed;
            if (this.battery < 0) this.battery = 0;
        }

        const myLaneY=this.getTargetLaneY();

        // 동방향 간격 유지 로직 (수평 레인)
        if(Math.abs(this.pos.y-myLaneY)<5){
            let atx=(this.state==='EVADING_TO_X')?this.evade_target:this.target_x;
            if(this.state==='REVERSING_FROM_INPUT_DOCK') atx=INPUT_EXIT_NODE.x;
            if(this.state==='REVERSING_FROM_OUTPUT_DOCK') atx=OUTPUT_EXIT_NODE.x;
            if(this.state==='FROM_CHARGE_DOCK') atx=CHARGE_EXIT_NODE.x;
            
            let ahead=amrs.find(o=>{
                if(o.id===this.id) return false;
                if(Math.abs(o.pos.y-myLaneY)>10) return false;
                let otx=(o.state==='EVADING_TO_X')?o.evade_target:o.target_x;
                if(o.state==='REVERSING_FROM_INPUT_DOCK') otx=INPUT_EXIT_NODE.x;
                if(o.state==='REVERSING_FROM_OUTPUT_DOCK') otx=OUTPUT_EXIT_NODE.x;
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
            
            let my_tx=(this.state==='REVERSING_FROM_INPUT_DOCK')?INPUT_EXIT_NODE.x:
                       (this.state==='REVERSING_FROM_OUTPUT_DOCK')?OUTPUT_EXIT_NODE.x:
                       (this.state==='FROM_CHARGE_DOCK')?CHARGE_EXIT_NODE.x:this.target_x;
                       
            let threat=amrs.find(o=>{
                if(o.id===this.id) return false;
                
                // 충전 구역 안으로 들어간 AMR은 메인 통로 충돌 위협 리스트에서 완전히 제외
                if (o.state === 'CHARGING' || o.state === 'ENTERING_BAY' || o.state === 'EXITING_BAY' || o.state === 'TO_CHARGE_DOCK') {
                    if (o.pos.y > AMR_LANE_Y + 10) return false;
                }
                
                let otx=(o.state==='EVADING_TO_X')?o.evade_target:o.target_x;
                if(o.state==='REVERSING_FROM_INPUT_DOCK') otx=INPUT_EXIT_NODE.x;
                if(o.state==='REVERSING_FROM_OUTPUT_DOCK') otx=OUTPUT_EXIT_NODE.x;
                if(o.state==='FROM_CHARGE_DOCK') otx=CHARGE_EXIT_NODE.x;
                let conflict=false;
                if(my_tx===OUTPUT_ENTRY_NODE.x){
                    if(Math.abs(o.pos.x-OUTPUT_ENTRY_X)<50&&o.pos.y>DOCKING_Y+10){
                        if(o.state==='UNLOADING'||o.state==='EXIT_OUTPUT_SIDE'||o.state==='FROM_OUTPUT_DOCK'||o.state==='TO_OUTPUT_DOCK') conflict=true;
                    }
                }
                if(my_tx===INPUT_EXIT_NODE.x){
                    if(Math.abs(o.pos.x-INPUT_EXIT_X)<50&&o.pos.y>DOCKING_Y+10){
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
                        if(!skipFront&&Math.abs(o.pos.x-this.pos.x)<250){
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
                            this.saved_target_x=(this.state==='REVERSING_FROM_INPUT_DOCK')?INPUT_EXIT_NODE.x:
                                                (this.state==='REVERSING_FROM_OUTPUT_DOCK')?OUTPUT_EXIT_NODE.x:CHARGE_EXIT_NODE.x;
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
                // 부하율 관계없이 설정된 복귀 시간 이하이면 무조건 충전소 직행
                if (this.battery <= this.min_return_time) {
                    this.state = 'EXIT_INPUT_SIDE';
                    this.next_state = 'TO_CHARGE_DOCK';
                    this.target_x = CHARGE_ENTRY_NODE.x;
                    break;
                }

                let tgts=ldrs.filter(l=>l.active && l.status==='DONE'&&!l.amr_assigned);
                if(tgts.length===0) tgts=ldrs.filter(l=>l.active && l.status==='CALLING'&&!l.amr_assigned);
                if(tgts.length>0){
                    tgts.sort((a,b)=>global_production[a.model.name]-global_production[b.model.name]);
                    this.target_ldr=tgts[0]; this.target_ldr.amr_assigned=true;
                    this.state='EXIT_INPUT_SIDE';
                    this.next_state='TO_INPUT_LANE';
                }
                break;
            }
            
            // ===== 신규 충전 이동 로직 =====
            case 'TO_CHARGE_DOCK': {
                let bayY = 480 + this.id * 60;
                if(this.moveTowards(CHARGE_ENTRY_X, bayY, step)) {
                    this.state = 'ENTERING_BAY';
                }
                break;
            }
            case 'ENTERING_BAY': {
                let bayY = 480 + this.id * 60;
                if(this.moveTowards(CHARGE_BAY_X, bayY, step)) {
                    this.state = 'CHARGING';
                }
                break;
            }
            case 'CHARGING':
                if(this.battery >= this.max_battery) {
                    this.state = 'EXITING_BAY';
                }
                break;
            case 'EXITING_BAY': {
                let bayY = 480 + this.id * 60;
                // 위에서 양보 로직(교차로)은 switch문 전에 처리됨
                if(this.moveTowards(CHARGE_EXIT_X, bayY, step)) {
                    this.state = 'FROM_CHARGE_DOCK';
                }
                break;
            }
            case 'FROM_CHARGE_DOCK':
                if(this.moveTowards(CHARGE_EXIT_X, AMR_LANE_Y, step)) {
                    this.state = 'MOVING_ON_LANE';
                    this.target_x = INPUT_ENTRY_NODE.x;
                    this.next_state = 'TO_INPUT_DOCK';
                }
                break;

            case 'EXIT_INPUT_SIDE':
                if(this.moveTowards(INPUT_EXIT_X, INPUT_ZONE.y, step)){
                    this.state = 'TO_INPUT_LANE_UP';
                }
                break;

            case 'TO_INPUT_LANE_UP':
                if(this.moveTowards(INPUT_EXIT_NODE.x, INPUT_EXIT_NODE.y, step)){
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
                if(this.moveTowards(this.target_x,this.getTargetLaneY(),step)){
                    this.state=this.next_state;
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
                if(this.target_ldr.status !== 'DONE') return; // 로더가 완벽히 작업 끝날 때까지 대기
                if(this.target_ldr.trays < this.target_ldr.targetTrays) return;
                this.wait_timer+=manager.speed;
                if(this.wait_timer>10){
                    stats.calls++;
                    this.payload=this.target_ldr.trays;
                    this.target_ldr.trays=0; this.target_ldr.pieces=0;
                    this.target_ldr.elapsed_time=0; this.target_ldr.status='IDLE';
                    this.target_ldr.amr_assigned=false; this.state='DOCKING_OUT';
                }
                break;

            case 'DOCKING_OUT':
                if(this.moveTowards(this.target_ldr.x,this.getTargetLaneY(),step)){
                    this.state='MOVING_ON_LANE';
                    this.target_x=OUTPUT_ENTRY_NODE.x;
                    this.next_state='TO_OUTPUT_DOCK';
                }
                break;

            case 'TO_OUTPUT_DOCK':
                if(this.moveTowards(OUTPUT_ZONE.x,OUTPUT_ZONE.y,step)){
                    this.state='UNLOADING'; this.wait_timer=0;
                }
                break;

            case 'UNLOADING':
                this.wait_timer+=manager.speed;
                if(this.wait_timer>10){
                    this.payload=0; this.target_ldr=null;
                    this.state='EXIT_OUTPUT_SIDE';
                }
                break;

            case 'EXIT_OUTPUT_SIDE':
                if(this.moveTowards(OUTPUT_EXIT_X, OUTPUT_ZONE.y, step)){
                    this.state='FROM_OUTPUT_DOCK';
                }
                break;

            case 'FROM_OUTPUT_DOCK':
                if(this.moveTowards(OUTPUT_EXIT_NODE.x, AMR_LANE_Y, step)){
                    this.state='MOVING_ON_LANE';
                    
                    // 하역을 마치고 메인 통로로 나왔을 때, 설정된 복귀 시간 이하면 바로 충전소 직행!
                    if (this.battery <= this.min_return_time) {
                        this.target_x = CHARGE_ENTRY_NODE.x;
                        this.next_state = 'TO_CHARGE_DOCK';
                    } else {
                        this.target_x = INPUT_ENTRY_NODE.x;
                        this.next_state = 'TO_INPUT_DOCK';
                    }
                }
                break;

            case 'TO_INPUT_DOCK':
                if(this.moveTowards(INPUT_ZONE.x,INPUT_ZONE.y,step)){
                    this.state='WAITING_INPUT';
                }
                break;

            case 'REVERSING_FROM_OUTPUT_DOCK':
                if(this.moveTowards(OUTPUT_EXIT_NODE.x,AMR_LANE_Y,step)){
                    this.state='MOVING_ON_LANE'; this.target_x=OUTPUT_EXIT_NODE.x; this.next_state='TO_OUTPUT_DOCK';
                }
                break;

            case 'REVERSING_FROM_INPUT_DOCK':
                if(this.moveTowards(INPUT_EXIT_NODE.x,AMR_LANE_Y,step)){
                    this.state='MOVING_ON_LANE'; this.target_x=INPUT_EXIT_NODE.x; this.next_state='TO_INPUT_DOCK';
                }
                break;

            case 'EVADING_TO_X':
                if(this.moveTowards(this.evade_target,AMR_LANE_Y,step)) this.state='EVADING_UP';
                break;

            case 'EVADING_UP':
                if(this.moveTowards(this.evade_target,DOCKING_Y,step)) this.state='EVADING_WAIT';
                break;

            case 'EVADING_WAIT':{
                let stx=this.saved_target_x;
                let still=amrs.some(a=>{
                    if(a.id===this.id) return false;
                    let atx=(a.state==='EVADING_TO_X')?a.evade_target:a.target_x;
                    if(a.state==='REVERSING_FROM_INPUT_DOCK') atx=INPUT_EXIT_NODE.x;
                    if(a.state==='REVERSING_FROM_OUTPUT_DOCK') atx=OUTPUT_EXIT_NODE.x;
                    if(a.state==='FROM_CHARGE_DOCK') atx=CHARGE_EXIT_NODE.x;
                    let conflict=false;
                    if(stx===OUTPUT_ENTRY_NODE.x){
                        if(Math.abs(a.pos.x-OUTPUT_ENTRY_X)<50&&a.pos.y>DOCKING_Y+10){
                            if(a.state==='UNLOADING'||a.state==='EXIT_OUTPUT_SIDE'||a.state==='FROM_OUTPUT_DOCK'||a.state==='TO_OUTPUT_DOCK') conflict=true;
                        }
                    }
                    if(stx===INPUT_EXIT_NODE.x){
                        if(Math.abs(a.pos.x-INPUT_EXIT_X)<50&&a.pos.y>DOCKING_Y+10){
                            if(a.state==='WAITING_INPUT'||a.state==='TO_INPUT_LANE_UP'||a.state==='TO_INPUT_DOCK'||a.state==='EXIT_INPUT_SIDE') conflict=true;
                        }
                    }
                    if(stx===CHARGE_ENTRY_NODE.x){
                        if(Math.abs(a.pos.x-CHARGE_ENTRY_X)<50&&a.pos.y>DOCKING_Y+10){
                            if(a.state==='ENTERING_BAY'||a.state==='TO_CHARGE_DOCK'||a.state==='CHARGING') conflict=true;
                        }
                    }
                    if(!conflict){
                        if(a.pos.y>DOCKING_Y+10&&Math.abs(a.pos.x-this.evade_target)<250){
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
                if(this.moveTowards(this.evade_target,AMR_LANE_Y,step)){
                    this.state=this.saved_state; this.target_x=this.saved_target_x; this.evade_target=null;
                }
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
        ctx.fillStyle='#0f172a'; ctx.fillRect(15,-10,10,20); ctx.fillRect(-25,-10,10,20);
        ctx.fillStyle='#3b82f6'; ctx.beginPath();
        ctx.arc(20,-5,2,0,Math.PI*2); ctx.arc(20,5,2,0,Math.PI*2);
        ctx.arc(-20,-5,2,0,Math.PI*2); ctx.arc(-20,5,2,0,Math.PI*2); ctx.fill();
        if(this.payload>0){
            ctx.fillStyle='#facc15'; ctx.fillRect(-15,-12,30,24);
            ctx.strokeStyle='#ca8a04'; ctx.strokeRect(-15,-12,30,24);
            ctx.fillStyle='#0f172a'; ctx.font='800 10px Inter';
            ctx.textAlign='center'; ctx.textBaseline='middle';
            ctx.fillText('OUT',0,0);
        } else {
            ctx.fillStyle=(this.payload===0&&this.target_ldr)?'#ec4899':this.color;
            ctx.beginPath(); ctx.roundRect(-22,-10,44,20,4); ctx.fill();
            ctx.fillStyle='#ffffff'; ctx.font='800 10px Inter';
            ctx.textAlign='center'; ctx.textBaseline='middle';
            let lbl='A'+(this.id+1);
            if(this.target_ldr) lbl+='->L'+(this.target_ldr.id+1);
            ctx.fillText(lbl,0,0);
        }
        ctx.restore();
    }
}

let manager=new SimulationManager();
let ldrs=[], amrs=[];

function resetAmrAssignments(){ ldrs.forEach(l=>l.amr_assigned=false); }

function setupLoaderGrid() {
    const grid = document.getElementById('loaderGrid');
    grid.innerHTML = '';
    ldrs.forEach((l, i) => {
        const div = document.createElement('div');
        div.className = 'loader-setting';
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
                <input type="number" value="${l.cycleTime}" onchange="ldrs[${i}].cycleTime = parseInt(this.value)">
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <span style="color:#64748b">목표단:</span>
                <input type="number" value="${l.targetTrays}" min="1" max="10" onchange="ldrs[${i}].targetTrays = parseInt(this.value)">
            </div>
            <button class="btn btn-toggle" onclick="window.toggleLoader(${i})">Toggle</button>
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
                <span>복귀:</span>
                <button class="btn-small" onclick="window.adjAmrReturnTime(${i}, -1800)">-</button>
                <span id="amr-ret-time-${i}">${a.min_return_time / 3600}h</span>
                <button class="btn-small" onclick="window.adjAmrReturnTime(${i}, 1800)">+</button>
            </div>
        `;
        grid.appendChild(div);
    });
}

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
    if (m) ldrs[i].model = m;
};

window.toggleLoader = function(i) {
    ldrs[i].active = !ldrs[i].active;
    const span = document.getElementById(`st-${i}`);
    span.innerText = ldrs[i].active ? "ON" : "OFF";
    span.className = ldrs[i].active ? "status-on" : "status-off";
};

function init(){
    global_production={'M3 5X':0,'M3 UPPER':0,'M3 2ND':0};
    document.getElementById('prod-m3-5x').innerText='0';
    document.getElementById('prod-m3-upper').innerText='0';
    document.getElementById('prod-m3-2nd').innerText='0';
    updateExtraSidings();
    ldrs=[]; amrs=[];
    for(let i=0;i<NUM_LOADER;i++){
        let l=new Loader(i,80+i*130); l.randomizeStart(); ldrs.push(l);
    }
    stats = { calls: 0, totalWait: 0 };
    setupLoaderGrid();
    amrs.push(new AMR(0,COLOR_AMR[0]));
    setupAmrGrid();
}

function update(){
    manager.update();
    ldrs.forEach(l=>l.update(manager.speed));
    let loadFactor = runAnalysis();
    amrs.forEach(a=>a.update(manager,amrs,ldrs,loadFactor));
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

    // ===== INPUT 구역: 입차전용(오른쪽) + 출차전용(왼쪽) =====
    let ix=INPUT_ZONE.x, iy=INPUT_ZONE.y;
    let iEntX=INPUT_ENTRY_X, iExX=INPUT_EXIT_X;
    let iLaneY=dual_lane?OUTPUT_LANE_Y:AMR_LANE_Y;

    ctx.strokeStyle='rgba(234,88,12,0.6)'; ctx.lineWidth=2; ctx.setLineDash([5,5]);
    ctx.beginPath(); ctx.moveTo(iEntX,iLaneY); ctx.lineTo(iEntX,iy-45); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle='rgba(16,185,129,0.6)'; ctx.lineWidth=2; ctx.setLineDash([5,5]);
    ctx.beginPath(); ctx.moveTo(iExX,iLaneY); ctx.lineTo(iExX,iy-45); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle='rgba(234,88,12,0.4)'; ctx.lineWidth=2;
    ctx.beginPath();
    ctx.moveTo(iExX-20,iLaneY+10); ctx.lineTo(iExX-20,iy+50);
    ctx.lineTo(iEntX+20,iy+50); ctx.lineTo(iEntX+20,iLaneY+10); ctx.stroke();
    ctx.fillStyle='rgba(234,88,12,0.8)'; ctx.font='bold 10px Inter'; ctx.textAlign='center';
    ctx.fillText('▼입차',iEntX,iLaneY+14);
    ctx.fillStyle='rgba(16,185,129,0.9)';
    ctx.fillText('▲출차',iExX,iLaneY+14);
    ctx.shadowColor='rgba(0,0,0,0.1)'; ctx.shadowBlur=5;
    ctx.fillStyle='#fde68a';
    ctx.beginPath(); ctx.roundRect(iExX-25,iy-45,iEntX-iExX+50,90,12); ctx.fill();
    ctx.shadowBlur=0; ctx.strokeStyle='#334155'; ctx.lineWidth=2; ctx.stroke();
    ctx.fillStyle='#0f172a'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.font='800 14px Inter'; ctx.fillText('INPUT',(iEntX+iExX)/2,iy);

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
        let bayY = 480 + i * 60;
        ctx.strokeStyle='rgba(59,130,246,0.4)'; ctx.lineWidth=2;
        ctx.beginPath(); ctx.moveTo(cExX, bayY); ctx.lineTo(CHARGE_BAY_X, bayY); ctx.stroke();
        
        ctx.shadowColor='rgba(0,0,0,0.1)'; ctx.shadowBlur=5;
        ctx.fillStyle='#bfdbfe';
        ctx.beginPath(); ctx.roundRect(CHARGE_BAY_X - 25, bayY - 20, 50, 40, 8); ctx.fill();
        ctx.shadowBlur=0; ctx.strokeStyle='#2563eb'; ctx.lineWidth=2; ctx.stroke();
        ctx.fillStyle='#1e3a8a'; ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.font='700 10px Inter'; ctx.fillText('충전 #'+(i+1), CHARGE_BAY_X, bayY);
    }

    // ===== OUTPUT 구역: 입차전용(왼쪽) + 출차전용(오른쪽) =====
    let ox=OUTPUT_ZONE.x, oy=OUTPUT_ZONE.y;
    let oEntX=OUTPUT_ENTRY_X, oExX=OUTPUT_EXIT_X;

    ctx.strokeStyle='rgba(59,130,246,0.6)'; ctx.lineWidth=2; ctx.setLineDash([5,5]);
    ctx.beginPath(); ctx.moveTo(oEntX,AMR_LANE_Y); ctx.lineTo(oEntX,oy+45); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle='rgba(139,92,246,0.6)'; ctx.lineWidth=2; ctx.setLineDash([5,5]);
    ctx.beginPath(); ctx.moveTo(oExX,AMR_LANE_Y); ctx.lineTo(oExX,oy+45); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle='rgba(59,130,246,0.4)'; ctx.lineWidth=2;
    ctx.beginPath();
    ctx.moveTo(oEntX-20,AMR_LANE_Y-10); ctx.lineTo(oEntX-20,oy-50);
    ctx.lineTo(oExX+20,oy-50); ctx.lineTo(oExX+20,AMR_LANE_Y-10); ctx.stroke();
    ctx.fillStyle='rgba(59,130,246,0.9)'; ctx.font='bold 10px Inter'; ctx.textAlign='center';
    ctx.fillText('▲입차',oEntX,AMR_LANE_Y-14);
    ctx.fillStyle='rgba(139,92,246,0.9)';
    ctx.fillText('▼출차',oExX,AMR_LANE_Y-14);
    ctx.shadowColor='rgba(0,0,0,0.1)'; ctx.shadowBlur=5;
    ctx.fillStyle='#bfdbfe';
    ctx.beginPath(); ctx.roundRect(oEntX-25,oy-45,oExX-oEntX+50,90,12); ctx.fill();
    ctx.shadowBlur=0; ctx.strokeStyle='#334155'; ctx.lineWidth=2; ctx.stroke();
    ctx.fillStyle='#0f172a'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.font='800 14px Inter'; ctx.fillText('OUTPUT',(oEntX+oExX)/2,oy);

    ldrs.forEach(l=>l.draw(ctx,manager.global_time));
    amrs.forEach(a=>a.draw(ctx));
}

function loop(){ update(); draw(); requestAnimationFrame(loop); }

const setActive=(sel,tgt)=>{
    document.querySelectorAll(sel).forEach(b=>b.classList.remove('active'));
    tgt.classList.add('active');
};

document.getElementById('btn-pause').addEventListener('click',e=>{manager.speed=0;setActive('#btn-pause,#btn-1x,#btn-2x,#btn-5x,#btn-10x',e.target);});
document.getElementById('btn-1x').addEventListener('click',e=>{manager.speed=1;setActive('#btn-pause,#btn-1x,#btn-2x,#btn-5x,#btn-10x',e.target);});
document.getElementById('btn-2x').addEventListener('click',e=>{manager.speed=2;setActive('#btn-pause,#btn-1x,#btn-2x,#btn-5x,#btn-10x',e.target);});
document.getElementById('btn-5x').addEventListener('click',e=>{manager.speed=5;setActive('#btn-pause,#btn-1x,#btn-2x,#btn-5x,#btn-10x',e.target);});
document.getElementById('btn-10x').addEventListener('click',e=>{manager.speed=10;setActive('#btn-pause,#btn-1x,#btn-2x,#btn-5x,#btn-10x',e.target);});

document.getElementById('btn-mode-8').addEventListener('click',e=>{call_mode='8_MAX';setActive('#btn-mode-8,#btn-mode-custom',e.target);});
document.getElementById('btn-mode-custom').addEventListener('click',e=>{call_mode='CUSTOM';setActive('#btn-mode-8,#btn-mode-custom',e.target);});
document.getElementById('input-custom-trays').addEventListener('change',e=>{custom_call_threshold=parseInt(e.target.value);});

document.getElementById('select-priority').addEventListener('change',e=>{priority_mode=e.target.value;});

document.getElementById('btn-lane1').addEventListener('click',e=>{
    dual_lane=false; setActive('#btn-lane1,#btn-lane2',e.target);
    document.getElementById('btn-lane2').textContent='+배출 2라인 추가';
});
document.getElementById('btn-lane2').addEventListener('click',e=>{
    dual_lane=!dual_lane;
    if(dual_lane){e.target.classList.add('active');document.getElementById('btn-lane1').classList.remove('active');e.target.textContent='배출 2라인 삭제';}
    else{e.target.classList.remove('active');document.getElementById('btn-lane1').classList.add('active');e.target.textContent='+배출 2라인 추가';}
});

document.getElementById('btn-evade-cnc').addEventListener('click',e=>{
    evade_mode='CNC_ONLY';
    extra_sidings=[];
    setActive('#btn-evade-cnc,#btn-evade-siding,#btn-evade-both',e.target);
});
document.getElementById('btn-evade-siding').addEventListener('click',e=>{
    evade_mode='SIDING_ONLY';
    updateExtraSidings();
    setActive('#btn-evade-cnc,#btn-evade-siding,#btn-evade-both',e.target);
});
document.getElementById('btn-evade-both').addEventListener('click',e=>{
    evade_mode='BOTH';
    updateExtraSidings();
    setActive('#btn-evade-cnc,#btn-evade-siding,#btn-evade-both',e.target);
});

document.getElementById('btn-amr1').addEventListener('click',e=>{setActive('#btn-amr1,#btn-amr2,#btn-amr3,#btn-amr4',e.target);resetAmrAssignments();amrs=[new AMR(0,COLOR_AMR[0])];setupAmrGrid();});
document.getElementById('btn-amr2').addEventListener('click',e=>{setActive('#btn-amr1,#btn-amr2,#btn-amr3,#btn-amr4',e.target);resetAmrAssignments();amrs=[new AMR(0,COLOR_AMR[0]),new AMR(1,COLOR_AMR[1])];setupAmrGrid();});
document.getElementById('btn-amr3').addEventListener('click',e=>{setActive('#btn-amr1,#btn-amr2,#btn-amr3,#btn-amr4',e.target);resetAmrAssignments();amrs=[new AMR(0,COLOR_AMR[0]),new AMR(1,COLOR_AMR[1]),new AMR(2,COLOR_AMR[2])];setupAmrGrid();});
document.getElementById('btn-amr4').addEventListener('click',e=>{setActive('#btn-amr1,#btn-amr2,#btn-amr3,#btn-amr4',e.target);resetAmrAssignments();amrs=[new AMR(0,COLOR_AMR[0]),new AMR(1,COLOR_AMR[1]),new AMR(2,COLOR_AMR[2]),new AMR(3,COLOR_AMR[3])];setupAmrGrid();});

document.getElementById('btn-reset').addEventListener('click',()=>{
    init();
    let ab=document.querySelector('#btn-amr1.active,#btn-amr2.active,#btn-amr3.active,#btn-amr4.active');
    if(ab) ab.click();
});

init();
loop();
