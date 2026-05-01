const canvas = document.getElementById('simCanvas');
const ctx = canvas.getContext('2d');

const WIDTH = 2000;
const HEIGHT = 750;
const NUM_LOADER = 13;

const AMR_LANE_Y = 340;
const OUTPUT_LANE_Y = 370;
const DOCKING_Y = 250;
const PED_LANE_Y = 410;
const EXCLUSION_BUFFER = 200;

// INPUT: 입차전용(ENTRY) x=1450, 출차전용(EXIT) x=1420 (30px 왼쪽)
const INPUT_ENTRY_X = 1450;
const INPUT_EXIT_X  = 1420;
const INPUT_ZONE  = {x: INPUT_ENTRY_X, y: 550};
const INPUT_ENTRY_NODE = {x: INPUT_ENTRY_X, y: AMR_LANE_Y};
const INPUT_EXIT_NODE  = {x: INPUT_EXIT_X,  y: AMR_LANE_Y};

// OUTPUT: 입차전용(ENTRY) x=1850, 출차전용(EXIT) x=1880 (30px 오른쪽)
const OUTPUT_ENTRY_X = 1850;
const OUTPUT_EXIT_X  = 1880;
const OUTPUT_ZONE  = {x: OUTPUT_ENTRY_X, y: 150};
const OUTPUT_ENTRY_NODE = {x: OUTPUT_ENTRY_X, y: AMR_LANE_Y};
const OUTPUT_EXIT_NODE  = {x: OUTPUT_EXIT_X,  y: AMR_LANE_Y};

// V18 호환용 alias
const INPUT_NODE  = INPUT_ENTRY_NODE;
const OUTPUT_NODE = OUTPUT_ENTRY_NODE;

let dual_lane = false;

const SIDING_GAP_ORDER = [
    795,405,1185,145,1575,665,1055,275,1445,535,925,1315
];

let extra_sidings = [];

// V20: evade_mode - CNC_ONLY: 로더위치, SIDING_ONLY: 로더사이 갭(13개 전체), BOTH: 모두
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
let call_mode = '8_MAX';
let custom_call_threshold = 5;
let priority_mode = 'LOADED_YIELDS';
let exclusion_active = true;

function isOutputZoneBusy(amrs, selfId) {
    if (!exclusion_active) return false;
    return amrs.some(a => {
        if (a.id === selfId) return false;
        const inCorridor =
            a.state === 'TO_OUTPUT_DOCK' || a.state === 'UNLOADING' ||
            a.state === 'EXIT_OUTPUT_SIDE' || a.state === 'FROM_OUTPUT_DOCK';
        if (inCorridor) return true;
        if (Math.abs(a.pos.x - OUTPUT_ENTRY_X) < EXCLUSION_BUFFER/2 &&
            a.pos.y !== AMR_LANE_Y && a.pos.y !== OUTPUT_LANE_Y) return true;
        return false;
    });
}

function isInputZoneBusy(amrs, selfId) {
    if (!exclusion_active) return false;
    return amrs.some(a => {
        if (a.id === selfId) return false;
        const inCorridor =
            a.state === 'TO_INPUT_DOCK' || a.state === 'WAITING_INPUT' ||
            a.state === 'EXIT_INPUT_SIDE' || a.state === 'TO_INPUT_LANE';
        if (inCorridor) return true;
        if (Math.abs(a.pos.x - INPUT_ENTRY_X) < EXCLUSION_BUFFER/2 &&
            a.pos.y !== AMR_LANE_Y && a.pos.y !== OUTPUT_LANE_Y) return true;
        return false;
    });
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
        if(id<4) this.model=MODELS[0];
        else if(id<9) this.model=MODELS[1];
        else this.model=MODELS[2];
        this.max_trays=8; this.pieces_per_tray=6;
    }
    randomizeStart(){
        this.trays=this.id%6; this.pieces=0;
        this.elapsed_time=(this.id*50)%this.model.ct;
        this.production_count=(this.trays*this.pieces_per_tray)+this.pieces;
        global_production[this.model.name]+=this.production_count;
    }
    update(speed){
        if(this.status==='RUNNING'||this.status==='CALLING'){
            this.elapsed_time+=speed;
            if(this.elapsed_time>=this.model.ct){
                this.elapsed_time-=this.model.ct;
                this.pieces++; this.production_count++;
                global_production[this.model.name]++;
                if(this.pieces>=this.pieces_per_tray){this.pieces=0;this.trays++;}
            }
            if(call_mode==='8_MAX'){
                if(this.trays>=this.max_trays-1&&this.status!=='CALLING') this.status='CALLING';
            } else if(call_mode==='CUSTOM'){
                if(this.trays>=custom_call_threshold&&this.trays<this.max_trays&&this.status!=='CALLING') this.status='CALLING';
            }
            if(this.trays>=this.max_trays){this.trays=this.max_trays;this.pieces=0;this.status='DONE';}
        } else if(this.status==='IDLE'&&this.trays===0&&this.pieces===0){
            this.status='RUNNING';
        }
    }
    draw(ctx,gt){
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
        else if(this.status==='CALLING') led=this.amr_assigned?(blink?'#3b82f6':'#1e3a8a'):(blink?'#f97316':'#9a3412');
        else if(this.status==='IDLE') led='#94a3b8';
        ctx.fillStyle=led; ctx.fillRect(this.x+13,this.y-32,16,13);
        ctx.fillStyle='#f1f5f9'; ctx.fillRect(this.x-32,this.y-15,64,60);
        ctx.strokeStyle='rgba(148,163,184,0.5)'; ctx.strokeRect(this.x-32,this.y-15,64,60);
        for(let i=0;i<this.max_trays;i++){
            let ty=this.y+35-(i*7);
            if(i<this.trays){ ctx.fillStyle='#facc15'; ctx.fillRect(this.x-22,ty,44,6); ctx.strokeStyle='#ca8a04'; ctx.strokeRect(this.x-22,ty,44,6); }
            else if(i===this.trays&&(this.status==='RUNNING'||this.status==='CALLING')&&this.pieces>0){
                ctx.fillStyle='#fef08a'; let pw=44/this.pieces_per_tray;
                for(let p=0;p<this.pieces;p++) ctx.fillRect(this.x-22+(p*pw),ty,pw-1,6);
            }
        }
        ctx.fillStyle='#eab308'; ctx.beginPath(); ctx.roundRect(this.x-38,this.y+50,76,5,{bl:6,br:6}); ctx.fill();
        ctx.fillStyle='#64748b'; ctx.font='bold 11px Inter';
        ctx.fillText('('+this.trays+'/8T)',this.x,this.y+70);
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
    }

    getTargetLaneY(){ return (dual_lane&&this.payload>0)?OUTPUT_LANE_Y:AMR_LANE_Y; }

    moveTowards(tx,ty,step){
        let dx=tx-this.pos.x, dy=ty-this.pos.y;
        if(Math.abs(dx)>step) this.pos.x+=Math.sign(dx)*step; else this.pos.x=tx;
        if(Math.abs(dy)>step) this.pos.y+=Math.sign(dy)*step; else this.pos.y=ty;
        return (this.pos.x===tx&&this.pos.y===ty);
    }

    update(manager,amrs,ldrs){
        let step=this.speed*manager.speed;
        const myLaneY=this.getTargetLaneY();

        // 동방향 130px 간격 유지
        if(Math.abs(this.pos.y-myLaneY)<5){
            let atx=(this.state==='EVADING_TO_X')?this.evade_target:this.target_x;
            if(this.state==='REVERSING_FROM_INPUT_DOCK') atx=INPUT_EXIT_NODE.x;
            if(this.state==='REVERSING_FROM_OUTPUT_DOCK') atx=OUTPUT_EXIT_NODE.x;
            let ahead=amrs.find(o=>{
                if(o.id===this.id) return false;
                if(Math.abs(o.pos.y-myLaneY)>10) return false;
                let otx=(o.state==='EVADING_TO_X')?o.evade_target:o.target_x;
                if(o.state==='REVERSING_FROM_INPUT_DOCK') otx=INPUT_EXIT_NODE.x;
                if(o.state==='REVERSING_FROM_OUTPUT_DOCK') otx=OUTPUT_EXIT_NODE.x;
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

        // 정면충돌 회피 (메인 레인)
        if(this.pos.y===AMR_LANE_Y&&(
            this.state==='MOVING_ON_LANE'||this.state==='TO_INPUT_LANE'||
            this.state==='FROM_OUTPUT_DOCK'||this.state==='REVERSING_FROM_INPUT_DOCK'||
            this.state==='REVERSING_FROM_OUTPUT_DOCK')){
            let my_tx=(this.state==='REVERSING_FROM_INPUT_DOCK')?INPUT_EXIT_NODE.x:
                       (this.state==='REVERSING_FROM_OUTPUT_DOCK')?OUTPUT_EXIT_NODE.x:this.target_x;
            let threat=amrs.find(o=>{
                if(o.id===this.id) return false;
                let otx=(o.state==='EVADING_TO_X')?o.evade_target:o.target_x;
                if(o.state==='REVERSING_FROM_INPUT_DOCK') otx=INPUT_EXIT_NODE.x;
                if(o.state==='REVERSING_FROM_OUTPUT_DOCK') otx=OUTPUT_EXIT_NODE.x;
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
                        if(this.state==='REVERSING_FROM_INPUT_DOCK'||this.state==='REVERSING_FROM_OUTPUT_DOCK'){
                            this.saved_state='MOVING_ON_LANE';
                            this.saved_target_x=(this.state==='REVERSING_FROM_INPUT_DOCK')?INPUT_EXIT_NODE.x:OUTPUT_EXIT_NODE.x;
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
                let tgts=ldrs.filter(l=>l.status==='DONE'&&!l.amr_assigned);
                if(tgts.length===0) tgts=ldrs.filter(l=>l.status==='CALLING'&&!l.amr_assigned);
                if(tgts.length>0){
                    tgts.sort((a,b)=>global_production[a.model.name]-global_production[b.model.name]);
                    this.target_ldr=tgts[0]; this.target_ldr.amr_assigned=true;
                    // V20: INPUT 출차 전용 라인으로 옆이동
                    this.state='EXIT_INPUT_SIDE';
                }
                break;
            }

            // V20 NEW: INPUT 출차 - 옆으로 이동 (entry X -> exit X)
            case 'EXIT_INPUT_SIDE':
                if(this.moveTowards(INPUT_EXIT_X, INPUT_ZONE.y, step)){
                    this.state='TO_INPUT_LANE';
                }
                break;

            case 'TO_INPUT_LANE':
                // 출차전용라인(INPUT_EXIT_X)으로 메인통로까지 올라감
                if(this.moveTowards(INPUT_EXIT_NODE.x, INPUT_EXIT_NODE.y, step)){
                    this.state='MOVING_ON_LANE';
                    this.target_x=this.target_ldr.x;
                    this.next_state='DOCKING_IN';
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
                if(call_mode==='8_MAX'&&this.target_ldr.trays<this.target_ldr.max_trays) return;
                this.wait_timer+=manager.speed;
                if(this.wait_timer>10){
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
                if(isOutputZoneBusy(amrs,this.id)){
                    let stopX=OUTPUT_ENTRY_X-EXCLUSION_BUFFER/2;
                    let wY=this.getTargetLaneY();
                    if(Math.abs(this.pos.x-stopX)>5||Math.abs(this.pos.y-wY)>5) this.moveTowards(stopX,wY,step);
                    break;
                }
                // 입차전용: OUTPUT_ENTRY_X로 올라감
                if(this.moveTowards(OUTPUT_ZONE.x,OUTPUT_ZONE.y,step)){
                    this.state='UNLOADING'; this.wait_timer=0;
                }
                break;

            case 'UNLOADING':
                this.wait_timer+=manager.speed;
                if(this.wait_timer>10){
                    this.payload=0; this.target_ldr=null;
                    // V20: 출차 전용라인으로 옆이동
                    this.state='EXIT_OUTPUT_SIDE';
                }
                break;

            // V20 NEW: OUTPUT 출차 - 옆으로 이동 (entry X -> exit X)
            case 'EXIT_OUTPUT_SIDE':
                if(this.moveTowards(OUTPUT_EXIT_X, OUTPUT_ZONE.y, step)){
                    this.state='FROM_OUTPUT_DOCK';
                }
                break;

            case 'FROM_OUTPUT_DOCK':
                // 출차전용라인(OUTPUT_EXIT_X)으로 내려옴
                if(this.moveTowards(OUTPUT_EXIT_NODE.x, AMR_LANE_Y, step)){
                    this.state='MOVING_ON_LANE';
                    this.target_x=INPUT_ENTRY_NODE.x;
                    this.next_state='TO_INPUT_DOCK';
                }
                break;

            case 'TO_INPUT_DOCK':
                if(isInputZoneBusy(amrs,this.id)){
                    let stopX=INPUT_ENTRY_X+EXCLUSION_BUFFER/2;
                    if(Math.abs(this.pos.x-stopX)>5||Math.abs(this.pos.y-AMR_LANE_Y)>5) this.moveTowards(stopX,AMR_LANE_Y,step);
                    break;
                }
                // 입차전용: INPUT_ENTRY_X로 내려감
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
                    let conflict=false;
                    if(stx===OUTPUT_ENTRY_NODE.x){
                        if(Math.abs(a.pos.x-OUTPUT_ENTRY_X)<50&&a.pos.y>DOCKING_Y+10){
                            if(a.state==='UNLOADING'||a.state==='EXIT_OUTPUT_SIDE'||a.state==='FROM_OUTPUT_DOCK'||a.state==='TO_OUTPUT_DOCK') conflict=true;
                        }
                    }
                    if(stx===INPUT_EXIT_NODE.x){
                        if(Math.abs(a.pos.x-INPUT_EXIT_X)<50&&a.pos.y>DOCKING_Y+10){
                            if(a.state==='WAITING_INPUT'||a.state==='TO_INPUT_LANE'||a.state==='TO_INPUT_DOCK'||a.state==='EXIT_INPUT_SIDE') conflict=true;
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
    amrs.push(new AMR(0,COLOR_AMR[0]));
}

function update(){
    manager.update();
    ldrs.forEach(l=>l.update(manager.speed));
    amrs.forEach(a=>a.update(manager,amrs,ldrs));
}

function drawArrow(ctx,x1,y,x2,color,sz){
    sz=sz||9;
    ctx.save(); ctx.strokeStyle=color; ctx.fillStyle=color; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(x1,y); ctx.lineTo(x2,y); ctx.stroke();
    let d=Math.sign(x2-x1);
    ctx.beginPath(); ctx.moveTo(x2,y); ctx.lineTo(x2-d*sz,y-sz/2); ctx.lineTo(x2-d*sz,y+sz/2); ctx.closePath(); ctx.fill();
    ctx.restore();
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

    // 레인 바닥 방향 화살표
    for(let ax=80;ax<WIDTH-80;ax+=200) drawArrow(ctx,ax,AMR_LANE_Y+6,ax+120,'rgba(234,88,12,0.45)',8);
    if(dual_lane){
        for(let ax=WIDTH-80;ax>80;ax-=200) drawArrow(ctx,ax,OUTPUT_LANE_Y+6,ax-120,'rgba(59,130,246,0.45)',8);
    }

    // 회피구간 하이라이트
    let evZones=[];
    if(evade_mode==='CNC_ONLY') evZones=ldrs.map(l=>({x:l.x}));
    else if(evade_mode==='SIDING_ONLY') evZones=extra_sidings.map(s=>({x:s.x}));
    else evZones=[...ldrs.map(l=>({x:l.x})),...extra_sidings.map(s=>({x:s.x}))];
    drawEvadeHighlight(ctx,evZones);

    // 진입금지 구역 시각화 (exclusion_active 시)
    if(exclusion_active){
        let oBusy=amrs.some(a=>isOutputZoneBusy(amrs,a.id)===false?false:true);
        let iBusy=amrs.some(a=>isInputZoneBusy(amrs,a.id)===false?false:true);
        if(oBusy){
            ctx.fillStyle='rgba(239,68,68,0.09)';
            ctx.fillRect(OUTPUT_ENTRY_X-EXCLUSION_BUFFER/2,AMR_LANE_Y-30,EXCLUSION_BUFFER,80);
            ctx.strokeStyle='rgba(239,68,68,0.4)'; ctx.lineWidth=1;
            ctx.strokeRect(OUTPUT_ENTRY_X-EXCLUSION_BUFFER/2,AMR_LANE_Y-30,EXCLUSION_BUFFER,80);
        }
        if(iBusy){
            ctx.fillStyle='rgba(239,68,68,0.09)';
            ctx.fillRect(INPUT_ENTRY_X-EXCLUSION_BUFFER/2,AMR_LANE_Y-30,EXCLUSION_BUFFER,80);
            ctx.strokeStyle='rgba(239,68,68,0.4)'; ctx.lineWidth=1;
            ctx.strokeRect(INPUT_ENTRY_X-EXCLUSION_BUFFER/2,AMR_LANE_Y-30,EXCLUSION_BUFFER,80);
        }
    }

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

    // 입차전용 라인 (오렌지, 아래방향)
    ctx.strokeStyle='rgba(234,88,12,0.6)'; ctx.lineWidth=2; ctx.setLineDash([5,5]);
    ctx.beginPath(); ctx.moveTo(iEntX,iLaneY); ctx.lineTo(iEntX,iy-45); ctx.stroke(); ctx.setLineDash([]);
    // 출차전용 라인 (초록, 위방향)
    ctx.strokeStyle='rgba(16,185,129,0.6)'; ctx.lineWidth=2; ctx.setLineDash([5,5]);
    ctx.beginPath(); ctx.moveTo(iExX,iLaneY); ctx.lineTo(iExX,iy-45); ctx.stroke(); ctx.setLineDash([]);
    // U박스
    ctx.strokeStyle='rgba(234,88,12,0.4)'; ctx.lineWidth=2;
    ctx.beginPath();
    ctx.moveTo(iExX-20,iLaneY+10); ctx.lineTo(iExX-20,iy+50);
    ctx.lineTo(iEntX+20,iy+50); ctx.lineTo(iEntX+20,iLaneY+10); ctx.stroke();
    // 입차/출차 화살표
    ctx.fillStyle='rgba(234,88,12,0.8)'; ctx.font='bold 10px Inter'; ctx.textAlign='center';
    ctx.fillText('▼입차',iEntX,iLaneY+14);
    ctx.fillStyle='rgba(16,185,129,0.9)';
    ctx.fillText('▲출차',iExX,iLaneY+14);
    // INPUT 박스
    ctx.shadowColor='rgba(0,0,0,0.1)'; ctx.shadowBlur=5;
    ctx.fillStyle='#fde68a';
    ctx.beginPath(); ctx.roundRect(iExX-25,iy-45,iEntX-iExX+50,90,12); ctx.fill();
    ctx.shadowBlur=0; ctx.strokeStyle='#334155'; ctx.lineWidth=2; ctx.stroke();
    ctx.fillStyle='#0f172a'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.font='800 14px Inter'; ctx.fillText('INPUT',(iEntX+iExX)/2,iy);

    // ===== OUTPUT 구역: 입차전용(왼쪽) + 출차전용(오른쪽) =====
    let ox=OUTPUT_ZONE.x, oy=OUTPUT_ZONE.y;
    let oEntX=OUTPUT_ENTRY_X, oExX=OUTPUT_EXIT_X;

    // 입차전용 라인 (파랑, 위방향)
    ctx.strokeStyle='rgba(59,130,246,0.6)'; ctx.lineWidth=2; ctx.setLineDash([5,5]);
    ctx.beginPath(); ctx.moveTo(oEntX,AMR_LANE_Y); ctx.lineTo(oEntX,oy+45); ctx.stroke(); ctx.setLineDash([]);
    // 출차전용 라인 (보라, 아래방향)
    ctx.strokeStyle='rgba(139,92,246,0.6)'; ctx.lineWidth=2; ctx.setLineDash([5,5]);
    ctx.beginPath(); ctx.moveTo(oExX,AMR_LANE_Y); ctx.lineTo(oExX,oy+45); ctx.stroke(); ctx.setLineDash([]);
    // U박스
    ctx.strokeStyle='rgba(59,130,246,0.4)'; ctx.lineWidth=2;
    ctx.beginPath();
    ctx.moveTo(oEntX-20,AMR_LANE_Y-10); ctx.lineTo(oEntX-20,oy-50);
    ctx.lineTo(oExX+20,oy-50); ctx.lineTo(oExX+20,AMR_LANE_Y-10); ctx.stroke();
    // 입차/출차 화살표
    ctx.fillStyle='rgba(59,130,246,0.9)'; ctx.font='bold 10px Inter'; ctx.textAlign='center';
    ctx.fillText('▲입차',oEntX,AMR_LANE_Y-14);
    ctx.fillStyle='rgba(139,92,246,0.9)';
    ctx.fillText('▼출차',oExX,AMR_LANE_Y-14);
    // OUTPUT 박스
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

document.getElementById('btn-1x').addEventListener('click',e=>{manager.speed=1;setActive('#btn-1x,#btn-2x,#btn-5x,#btn-10x',e.target);});
document.getElementById('btn-2x').addEventListener('click',e=>{manager.speed=2;setActive('#btn-1x,#btn-2x,#btn-5x,#btn-10x',e.target);});
document.getElementById('btn-5x').addEventListener('click',e=>{manager.speed=5;setActive('#btn-1x,#btn-2x,#btn-5x,#btn-10x',e.target);});
document.getElementById('btn-10x').addEventListener('click',e=>{manager.speed=10;setActive('#btn-1x,#btn-2x,#btn-5x,#btn-10x',e.target);});

document.getElementById('btn-mode-8').addEventListener('click',e=>{setActive('#btn-mode-8,#btn-mode-custom',e.target);call_mode='8_MAX';});
document.getElementById('btn-mode-custom').addEventListener('click',e=>{setActive('#btn-mode-8,#btn-mode-custom',e.target);call_mode='CUSTOM';});
document.getElementById('input-custom-trays').addEventListener('change',e=>{
    let v=parseInt(e.target.value);
    if(v>=1&&v<=7) custom_call_threshold=v; else e.target.value=custom_call_threshold;
});



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

document.getElementById('btn-excl-on').addEventListener('click',e=>{exclusion_active=true;setActive('#btn-excl-on,#btn-excl-off',e.target);});
document.getElementById('btn-excl-off').addEventListener('click',e=>{exclusion_active=false;setActive('#btn-excl-on,#btn-excl-off',e.target);});

document.getElementById('btn-evade-cnc').addEventListener('click',e=>{
    evade_mode='CNC_ONLY';
    extra_sidings=[];
    setActive('#btn-evade-cnc,#btn-evade-siding,#btn-evade-both',e.target);
});
document.getElementById('btn-evade-siding').addEventListener('click',e=>{
    evade_mode='SIDING_ONLY';
    // 회피존만 사용: 13개 전체 즉시 활성화
    updateExtraSidings();
    setActive('#btn-evade-cnc,#btn-evade-siding,#btn-evade-both',e.target);
});
document.getElementById('btn-evade-both').addEventListener('click',e=>{
    evade_mode='BOTH';
    // 둘다 사용: 13개 회피존 + CNC 도킹존
    updateExtraSidings();
    setActive('#btn-evade-cnc,#btn-evade-siding,#btn-evade-both',e.target);
});

document.getElementById('btn-amr1').addEventListener('click',e=>{setActive('#btn-amr1,#btn-amr2,#btn-amr3,#btn-amr4',e.target);resetAmrAssignments();amrs=[new AMR(0,COLOR_AMR[0])];});
document.getElementById('btn-amr2').addEventListener('click',e=>{setActive('#btn-amr1,#btn-amr2,#btn-amr3,#btn-amr4',e.target);resetAmrAssignments();amrs=[new AMR(0,COLOR_AMR[0]),new AMR(1,COLOR_AMR[1])];});
document.getElementById('btn-amr3').addEventListener('click',e=>{setActive('#btn-amr1,#btn-amr2,#btn-amr3,#btn-amr4',e.target);resetAmrAssignments();amrs=[new AMR(0,COLOR_AMR[0]),new AMR(1,COLOR_AMR[1]),new AMR(2,COLOR_AMR[2])];});
document.getElementById('btn-amr4').addEventListener('click',e=>{setActive('#btn-amr1,#btn-amr2,#btn-amr3,#btn-amr4',e.target);resetAmrAssignments();amrs=[new AMR(0,COLOR_AMR[0]),new AMR(1,COLOR_AMR[1]),new AMR(2,COLOR_AMR[2]),new AMR(3,COLOR_AMR[3])];});

document.getElementById('btn-reset').addEventListener('click',()=>{
    init();
    let ab=document.querySelector('#btn-amr1.active,#btn-amr2.active,#btn-amr3.active,#btn-amr4.active');
    if(ab) ab.click();
});

init();
loop();
