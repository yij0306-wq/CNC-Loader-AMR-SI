const canvas = document.getElementById('simCanvas');
const ctx = canvas.getContext('2d');

const WIDTH = 1350;
const HEIGHT = 750;
const NUM_LOADER = 13;

const AMR_LANE_Y = 350; 
const DOCKING_Y = 250;
const PED_LANE_Y = 410;

const INPUT_ZONE = {x: 1000, y: 550};
const INPUT_NODE = {x: 1000, y: AMR_LANE_Y};
const OUTPUT_ZONE = {x: 1250, y: 150};
const OUTPUT_NODE = {x: 1250, y: AMR_LANE_Y};

// V10: 회피존 분산 배열 
// 1호기(80)~13호기(1100) 사이의 12개 간격(42.5px shift)을 분산된 순서로 나열
const SIDING_GAP_ORDER = [
    547.5,  // 6~7호기 사이
    292.5,  // 3~4호기 사이
    802.5,  // 9~10호기 사이
    122.5,  // 1~2호기 사이
    1057.5, // 12~13호기 사이
    462.5,  // 5~6호기 사이
    717.5,  // 8~9호기 사이
    207.5,  // 2~3호기 사이
    972.5,  // 11~12호기 사이
    377.5,  // 4~5호기 사이
    632.5,  // 7~8호기 사이
    887.5   // 10~11호기 사이
];

let extra_sidings = [
    {x: 1180, y: DOCKING_Y, type: 'EXTRA'}
];

const COLOR_AMR_LANE = 'rgba(249, 115, 22, 0.15)'; 
const COLOR_AMR_LINE = '#ea580c'; 
const COLOR_PED_LANE = '#e2e8f0'; 
const COLOR_AMR = ['#2563eb', '#10b981', '#8b5cf6', '#eab308'];

const MODELS = [
    { name: "M3 5X", ct: 145 },    
    { name: "M3 UPPER", ct: 145 }, 
    { name: "M3 2ND", ct: 120 }    
];

let global_production = {
    "M3 5X": 0,
    "M3 UPPER": 0,
    "M3 2ND": 0
};

// V9 호출 모드 전역 변수
let call_mode = '8_MAX'; 
let custom_call_threshold = 5;

class SimulationManager {
    constructor() {
        this.speed = 1;
        this.global_time = 0; 
    }

    update() {
        this.global_time += this.speed;
        document.getElementById('prod-m3-5x').innerText = global_production["M3 5X"].toLocaleString();
        document.getElementById('prod-m3-upper').innerText = global_production["M3 UPPER"].toLocaleString();
        document.getElementById('prod-m3-2nd').innerText = global_production["M3 2ND"].toLocaleString();
    }
}

class Loader {
    constructor(id, x) {
        this.id = id;
        this.x = x;
        this.y = 170; 
        this.status = "RUNNING"; 
        this.amr_assigned = false; 
        
        this.elapsed_time = 0;
        this.pieces = 0;
        this.trays = 0;
        this.production_count = 0; 
        
        if (id < 4) this.model = MODELS[0];
        else if (id < 9) this.model = MODELS[1];
        else this.model = MODELS[2];
        
        this.max_trays = 8;
        this.pieces_per_tray = 6;
    }

    randomizeStart() {
        this.trays = this.id % 6; 
        this.pieces = 0;
        this.elapsed_time = (this.id * 50) % this.model.ct;
        this.production_count = (this.trays * this.pieces_per_tray) + this.pieces;
        global_production[this.model.name] += this.production_count;
    }

    update(speed) {
        if (this.status === "RUNNING" || this.status === "CALLING") {
            this.elapsed_time += speed;
            if (this.elapsed_time >= this.model.ct) {
                this.elapsed_time -= this.model.ct;
                this.pieces++;
                
                this.production_count++;
                global_production[this.model.name]++;
                
                if (this.pieces >= this.pieces_per_tray) {
                    this.pieces = 0;
                    this.trays++;
                }
            }
            
            if (call_mode === 'CUSTOM') {
                if (this.trays >= custom_call_threshold && this.trays < this.max_trays && this.status !== "CALLING") {
                    this.status = "CALLING";
                }
            }
            
            if (this.trays >= this.max_trays) {
                this.trays = this.max_trays;
                this.pieces = 0;
                this.status = "DONE";
            }
        } else if (this.status === "IDLE" && this.trays === 0 && this.pieces === 0) {
            this.status = "RUNNING"; 
        }
    }

    draw(ctx, global_time) {
        ctx.fillStyle = '#0f172a';
        ctx.font = '800 14px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`LOADER-${this.id + 1}`, this.x, this.y - 75);
        
        ctx.fillStyle = '#2563eb';
        ctx.font = 'bold 12px Inter';
        ctx.fillText(this.model.name, this.x, this.y - 60);

        let gradient = ctx.createLinearGradient(this.x - 35, this.y - 40, this.x + 35, this.y + 50);
        gradient.addColorStop(0, '#ffffff');
        gradient.addColorStop(1, '#e2e8f0');

        ctx.shadowColor = 'rgba(0,0,0,0.2)';
        ctx.shadowBlur = 10;
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.roundRect(this.x - 38, this.y - 45, 76, 100, 6);
        ctx.fill();
        ctx.shadowBlur = 0;
        
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#1e293b';
        ctx.fillRect(this.x + 10, this.y - 35, 22, 35);
        ctx.fillStyle = '#334155'; 
        ctx.fillRect(this.x + 12, this.y - 33, 18, 15);
        
        let ledColor = '#22c55e'; 
        let blink = Math.floor(global_time / 30) % 2 === 0;

        if (this.status === "DONE") {
            ledColor = '#ef4444'; 
        } else if (this.status === "CALLING") {
            if (this.amr_assigned) {
                ledColor = blink ? '#3b82f6' : '#1e3a8a';
            } else {
                ledColor = blink ? '#f97316' : '#9a3412';
            }
        } else if (this.status === "IDLE") {
            ledColor = '#94a3b8';
        }
        ctx.fillStyle = ledColor;
        ctx.fillRect(this.x + 13, this.y - 32, 16, 13);

        ctx.fillStyle = '#f1f5f9';
        ctx.fillRect(this.x - 32, this.y - 15, 64, 60);
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.5)';
        ctx.strokeRect(this.x - 32, this.y - 15, 64, 60);

        for (let i = 0; i < this.max_trays; i++) {
            let trayY = this.y + 35 - (i * 7);
            
            if (i < this.trays) {
                ctx.fillStyle = '#facc15'; 
                ctx.fillRect(this.x - 22, trayY, 44, 6);
                ctx.strokeStyle = '#ca8a04';
                ctx.strokeRect(this.x - 22, trayY, 44, 6);
            } else if (i === this.trays && (this.status === "RUNNING" || this.status === "CALLING") && this.pieces > 0) {
                ctx.fillStyle = '#fef08a';
                let pieceWidth = 44 / this.pieces_per_tray;
                for (let p = 0; p < this.pieces; p++) {
                    ctx.fillRect(this.x - 22 + (p * pieceWidth), trayY, pieceWidth - 1, 6);
                }
            }
        }

        ctx.fillStyle = '#eab308';
        ctx.beginPath();
        ctx.roundRect(this.x - 38, this.y + 50, 76, 5, {bl: 6, br: 6});
        ctx.fill();

        ctx.fillStyle = '#64748b';
        ctx.font = 'bold 11px Inter';
        ctx.fillText(`(${this.trays}/8T)`, this.x, this.y + 70);

        ctx.fillStyle = '#10b981';
        ctx.font = 'bold 12px Inter';
        ctx.fillText(`생산: ${this.production_count.toLocaleString()}개`, this.x, this.y + 90);
    }
}

class AMR {
    constructor(id, color) {
        this.id = id;
        this.color = color;
        this.pos = { ...INPUT_ZONE };
        this.state = "WAITING_INPUT"; 
        this.speed = 3;
        this.payload = 0;
        this.target_ldr = null;
        this.wait_timer = 0;
        this.target_x = this.pos.x;
        this.target_y = this.pos.y;
        
        this.evade_target = null; 
        this.saved_target_x = null;
        this.saved_state = null;
    }

    moveTowards(tx, ty, step) {
        let dx = tx - this.pos.x;
        let dy = ty - this.pos.y;
        if (Math.abs(dx) > step) this.pos.x += Math.sign(dx) * step;
        else this.pos.x = tx;
        if (Math.abs(dy) > step) this.pos.y += Math.sign(dy) * step;
        else this.pos.y = ty;
        return (this.pos.x === tx && this.pos.y === ty);
    }

    update(manager, amrs, ldrs) {
        let step = this.speed * manager.speed;

        if (this.pos.y === AMR_LANE_Y && (this.state === "MOVING_ON_LANE" || this.state === "TO_INPUT_LANE" || this.state === "FROM_OUTPUT_DOCK")) {
            
            // 1. 역주행/정면 충돌 위협 감지 
            let threat = amrs.find(other => {
                if (other.id === this.id) return false;
                if (other.pos.y <= DOCKING_Y + 10) return false;
                if (Math.abs(other.pos.x - this.pos.x) >= 250) return false;
                if (Math.sign(this.target_x - this.pos.x) === Math.sign(other.target_x - other.pos.x)) return false;
                
                let this_empty_to_loader = (this.payload === 0 && this.target_ldr !== null);
                let other_empty_to_loader = (other.payload === 0 && other.target_ldr !== null);
                
                let this_loaded_to_output = (this.payload > 0);
                let other_loaded_to_output = (other.payload > 0);
                
                if (this_loaded_to_output && other_empty_to_loader) return true; 
                if (this_empty_to_loader && other_loaded_to_output) return false;
                
                return other.id < this.id;
            });

            // 2. 동방향 추돌 감지 (Tailgate)
            let tailgate = amrs.find(other => 
                other.id !== this.id &&
                other.pos.y > DOCKING_Y + 10 &&
                Math.abs(other.pos.x - this.pos.x) < 70 && 
                (this.target_x > this.pos.x ? other.pos.x > this.pos.x : other.pos.x < this.pos.x) 
            );

            if (threat) {
                // 회피 발동! 
                let evade_candidates = [...ldrs.map(l => l.x), ...extra_sidings.map(s => s.x)];
                
                let freeX = evade_candidates.filter(x => 
                    !amrs.some(a => a.target_ldr && a.target_ldr.x === x) && 
                    !amrs.some(a => a.evade_target === x) &&
                    !amrs.some(a => Math.abs(a.pos.x - x) < 10 && a.pos.y <= DOCKING_Y + 10)
                );
                
                if (freeX.length > 0) {
                    let nearestX = freeX.sort((a,b) => Math.abs(a - this.pos.x) - Math.abs(b - this.pos.x))[0];
                    this.saved_state = this.state;
                    this.saved_target_x = this.target_x;
                    this.evade_target = nearestX;
                    this.state = "EVADING_TO_X";
                } else {
                    return; 
                }
            } else if (tailgate) {
                // V10: 둘 다 OUTPUT 방향일 때 후행 AMR 회피 로직
                if (this.payload > 0 && tailgate.payload > 0) {
                    let evade_candidates = [...ldrs.map(l => l.x), ...extra_sidings.map(s => s.x)];
                    
                    let freeX = evade_candidates.filter(x => 
                        !amrs.some(a => a.target_ldr && a.target_ldr.x === x) && 
                        !amrs.some(a => a.evade_target === x) &&
                        !amrs.some(a => Math.abs(a.pos.x - x) < 10 && a.pos.y <= DOCKING_Y + 10)
                    );
                    
                    if (freeX.length > 0) {
                        let nearestX = freeX.sort((a,b) => Math.abs(a - this.pos.x) - Math.abs(b - this.pos.x))[0];
                        this.saved_state = this.state;
                        this.saved_target_x = this.target_x;
                        this.evade_target = nearestX;
                        this.state = "EVADING_TO_X";
                        return; // 즉시 회피 기동 시작
                    }
                }
                return; // 회피할 곳이 없거나 OUTPUT 가는 상황이 아니면 정지
            }
        }

        switch(this.state) {
            case "WAITING_INPUT":
                // V10: 생산량 기반 타겟 선정 로직
                let targets = ldrs.filter(l => l.status === "DONE" && !l.amr_assigned);
                if (targets.length === 0 && call_mode === 'CUSTOM') {
                    targets = ldrs.filter(l => l.status === "CALLING" && !l.amr_assigned);
                }
                
                if (targets.length > 0) {
                    // 품목별 글로벌 생산량이 가장 낮은 순으로 정렬
                    targets.sort((a, b) => global_production[a.model.name] - global_production[b.model.name]);
                    this.target_ldr = targets[0];
                    this.target_ldr.amr_assigned = true; 
                    this.state = "TO_INPUT_LANE";
                }
                break;

            case "TO_INPUT_LANE":
                if (this.moveTowards(INPUT_NODE.x, INPUT_NODE.y, step)) {
                    this.state = "MOVING_ON_LANE";
                    this.target_x = this.target_ldr.x;
                    this.next_state = "DOCKING_IN";
                }
                break;

            case "MOVING_ON_LANE":
                if (this.moveTowards(this.target_x, AMR_LANE_Y, step)) {
                    this.state = this.next_state;
                }
                break;

            case "DOCKING_IN":
                if (this.moveTowards(this.target_ldr.x, DOCKING_Y, step)) {
                    this.state = "LOADING_WAIT";
                    this.wait_timer = 0;
                }
                break;

            case "LOADING_WAIT":
                this.wait_timer += manager.speed;
                if (this.wait_timer > 10) { 
                    this.payload = this.target_ldr.trays;
                    this.target_ldr.trays = 0;
                    this.target_ldr.pieces = 0;
                    this.target_ldr.elapsed_time = 0;
                    this.target_ldr.status = "IDLE";
                    this.target_ldr.amr_assigned = false;
                    this.state = "DOCKING_OUT";
                }
                break;

            case "DOCKING_OUT":
                if (this.moveTowards(this.target_ldr.x, AMR_LANE_Y, step)) {
                    this.state = "MOVING_ON_LANE";
                    this.target_x = OUTPUT_NODE.x;
                    this.next_state = "TO_OUTPUT_DOCK";
                }
                break;

            case "TO_OUTPUT_DOCK":
                if (this.moveTowards(OUTPUT_ZONE.x, OUTPUT_ZONE.y, step)) {
                    this.state = "UNLOADING";
                    this.wait_timer = 0;
                }
                break;

            case "UNLOADING":
                this.wait_timer += manager.speed;
                if (this.wait_timer > 10) { 
                    this.payload = 0;
                    this.target_ldr = null; 
                    this.state = "FROM_OUTPUT_DOCK";
                }
                break;

            case "FROM_OUTPUT_DOCK":
                if (this.moveTowards(OUTPUT_NODE.x, OUTPUT_NODE.y, step)) {
                    this.state = "MOVING_ON_LANE";
                    this.target_x = INPUT_NODE.x;
                    this.next_state = "TO_INPUT_DOCK";
                }
                break;

            case "TO_INPUT_DOCK":
                if (this.moveTowards(INPUT_ZONE.x, INPUT_ZONE.y, step)) {
                    this.state = "WAITING_INPUT";
                }
                break;

            case "EVADING_TO_X":
                let evade_tailgate = amrs.find(other => 
                    other.id !== this.id &&
                    other.pos.y > DOCKING_Y + 10 &&
                    Math.abs(other.pos.x - this.pos.x) < 70 &&
                    (this.evade_target > this.pos.x ? other.pos.x > this.pos.x : other.pos.x < this.pos.x)
                );
                if (evade_tailgate) return;

                if (this.moveTowards(this.evade_target, AMR_LANE_Y, step)) {
                    this.state = "EVADING_UP";
                }
                break;

            case "EVADING_UP":
                if (this.moveTowards(this.evade_target, DOCKING_Y, step)) {
                    this.state = "EVADING_WAIT";
                }
                break;

            case "EVADING_WAIT":
                let threatStillExists = amrs.some(a => 
                    a.id < this.id && 
                    a.pos.y > DOCKING_Y + 10 && 
                    Math.abs(a.pos.x - this.evade_target) < 150 &&
                    Math.sign(this.target_x - this.evade_target) !== Math.sign(a.target_x - a.pos.x)
                );
                
                // 전방(목적지 방향)이 다른 AMR로 꽉 막혀있는지 확인
                let exitBlocked = amrs.some(a => a.id !== this.id && Math.abs(a.pos.y - AMR_LANE_Y) < 10 && Math.abs(a.pos.x - this.evade_target) < 60);

                if (!threatStillExists && !exitBlocked) {
                    this.state = "EVADING_DOWN";
                }
                break;

            case "EVADING_DOWN":
                if (this.moveTowards(this.evade_target, AMR_LANE_Y, step)) {
                    this.state = this.saved_state; 
                    this.target_x = this.saved_target_x;
                    this.evade_target = null;
                }
                break;
        }
    }

    draw(ctx) {
        ctx.save();
        ctx.translate(this.pos.x, this.pos.y);

        ctx.shadowColor = 'rgba(0,0,0,0.3)';
        ctx.shadowBlur = 8;
        
        let grad = ctx.createLinearGradient(-25, -15, 25, 15);
        grad.addColorStop(0, '#f8fafc');
        grad.addColorStop(1, '#cbd5e1');
        
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.roundRect(-25, -18, 50, 36, 6);
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.lineWidth = 2;
        ctx.strokeStyle = '#475569';
        ctx.stroke();

        ctx.fillStyle = '#0f172a';
        ctx.fillRect(15, -10, 10, 20); 
        ctx.fillRect(-25, -10, 10, 20); 

        ctx.fillStyle = '#3b82f6';
        ctx.beginPath();
        ctx.arc(20, -5, 2, 0, Math.PI*2);
        ctx.arc(20, 5, 2, 0, Math.PI*2);
        ctx.arc(-20, -5, 2, 0, Math.PI*2);
        ctx.arc(-20, 5, 2, 0, Math.PI*2);
        ctx.fill();

        if (this.payload > 0) {
            ctx.fillStyle = '#facc15';
            ctx.fillRect(-15, -12, 30, 24);
            ctx.strokeStyle = '#ca8a04';
            ctx.strokeRect(-15, -12, 30, 24);
            
            ctx.fillStyle = '#0f172a';
            ctx.font = '800 10px Inter';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`▶OUT`, 0, 0);
        } else {
            if (this.payload === 0 && this.target_ldr !== null) {
                ctx.fillStyle = '#ec4899';
            } else {
                ctx.fillStyle = this.color;
            }
            
            ctx.beginPath();
            ctx.roundRect(-22, -10, 44, 20, 4);
            ctx.fill();

            ctx.fillStyle = '#ffffff';
            ctx.font = '800 10px Inter';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            
            let label = `A${this.id+1}`;
            if (this.target_ldr) {
                label += `▶L${this.target_ldr.id+1}`;
            }
            ctx.fillText(label, 0, 0);
        }
        ctx.restore();
    }
}

let manager = new SimulationManager();
let ldrs = [];
let amrs = [];

function resetAmrAssignments() {
    ldrs.forEach(l => l.amr_assigned = false);
}

function init() {
    global_production = {"M3 5X": 0, "M3 UPPER": 0, "M3 2ND": 0};
    document.getElementById('prod-m3-5x').innerText = '0';
    document.getElementById('prod-m3-upper').innerText = '0';
    document.getElementById('prod-m3-2nd').innerText = '0';
    
    extra_sidings = [{x: 1180, y: DOCKING_Y, type: 'EXTRA'}];

    ldrs = [];
    amrs = [];
    for (let i = 0; i < NUM_LOADER; i++) {
        let ldr = new Loader(i, 80 + i * 85);
        ldr.randomizeStart(); 
        ldrs.push(ldr);
    }
    amrs.push(new AMR(0, COLOR_AMR[0]));
}

function update() {
    manager.update();
    ldrs.forEach(ldr => ldr.update(manager.speed));
    amrs.forEach(amr => amr.update(manager, amrs, ldrs));
}

function draw() {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    ctx.fillStyle = COLOR_PED_LANE;
    ctx.fillRect(0, PED_LANE_Y - 25, WIDTH, 50);
    ctx.fillStyle = '#64748b';
    ctx.font = '800 14px Inter';
    ctx.textAlign = 'left';
    ctx.fillText("보행자", 20, PED_LANE_Y + 5);

    ctx.fillStyle = COLOR_AMR_LANE;
    ctx.fillRect(0, AMR_LANE_Y - 25, WIDTH, 50);
    
    ctx.beginPath();
    ctx.moveTo(0, AMR_LANE_Y);
    ctx.lineTo(WIDTH, AMR_LANE_Y);
    ctx.strokeStyle = COLOR_AMR_LINE;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = COLOR_AMR_LINE;
    ctx.fillText("AMR", 20, AMR_LANE_Y - 10);

    ctx.strokeStyle = 'rgba(234, 88, 12, 0.4)'; 
    ctx.lineWidth = 2;
    
    let drawDockingLine = (x) => {
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(x, AMR_LANE_Y);
        ctx.lineTo(x, DOCKING_Y);
        ctx.stroke();
        
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x - 30, AMR_LANE_Y - 10);
        ctx.lineTo(x - 30, DOCKING_Y - 20);
        ctx.lineTo(x + 30, DOCKING_Y - 20);
        ctx.lineTo(x + 30, AMR_LANE_Y - 10);
        ctx.stroke();
    };

    ldrs.forEach(ldr => drawDockingLine(ldr.x));
    
    // 회피 구역 선 그리기
    extra_sidings.forEach((siding, index) => {
        drawDockingLine(siding.x);
        ctx.fillStyle = '#38bdf8';
        ctx.font = 'bold 12px Inter';
        ctx.textAlign = 'center';
        // 기본 1180 위치는 회피 구역, 동적 추가된 구역은 S1, S2... 등으로 표시
        let label = index === 0 ? "회피 구역" : `S${index}`;
        ctx.fillText(label, siding.x, siding.y - 35);
    });

    ctx.beginPath();
    ctx.moveTo(INPUT_ZONE.x, AMR_LANE_Y);
    ctx.lineTo(INPUT_ZONE.x, INPUT_ZONE.y);
    ctx.moveTo(OUTPUT_ZONE.x, AMR_LANE_Y);
    ctx.lineTo(OUTPUT_ZONE.x, OUTPUT_ZONE.y);
    ctx.setLineDash([5, 5]);
    ctx.stroke();
    ctx.setLineDash([]);

    const drawZone = (zone, color, label) => {
        ctx.shadowColor = 'rgba(0,0,0,0.1)';
        ctx.shadowBlur = 5;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(zone.x - 45, zone.y - 45, 90, 90, 12);
        ctx.fill();
        ctx.shadowBlur = 0;
        
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        ctx.fillStyle = '#0f172a';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '800 16px Inter';
        ctx.fillText(label, zone.x, zone.y);
    };

    drawZone(INPUT_ZONE, '#fde68a', 'INPUT');
    drawZone(OUTPUT_ZONE, '#bfdbfe', 'OUTPUT');

    ldrs.forEach(ldr => ldr.draw(ctx, manager.global_time));
    amrs.forEach(amr => amr.draw(ctx));
}

function loop() {
    update();
    draw();
    requestAnimationFrame(loop);
}

const setActive = (group, target) => {
    document.querySelectorAll(group).forEach(b => b.classList.remove('active'));
    target.classList.add('active');
};

document.getElementById('btn-1x').addEventListener('click', (e) => { manager.speed = 1; setActive('#btn-1x, #btn-2x, #btn-5x, #btn-10x', e.target); });
document.getElementById('btn-2x').addEventListener('click', (e) => { manager.speed = 2; setActive('#btn-1x, #btn-2x, #btn-5x, #btn-10x', e.target); });
document.getElementById('btn-5x').addEventListener('click', (e) => { manager.speed = 5; setActive('#btn-1x, #btn-2x, #btn-5x, #btn-10x', e.target); });
document.getElementById('btn-10x').addEventListener('click', (e) => { manager.speed = 10; setActive('#btn-1x, #btn-2x, #btn-5x, #btn-10x', e.target); });

document.getElementById('btn-mode-8').addEventListener('click', (e) => {
    setActive('#btn-mode-8, #btn-mode-custom', e.target);
    call_mode = '8_MAX';
});

document.getElementById('btn-mode-custom').addEventListener('click', (e) => {
    setActive('#btn-mode-8, #btn-mode-custom', e.target);
    call_mode = 'CUSTOM';
});

document.getElementById('input-custom-trays').addEventListener('change', (e) => {
    let val = parseInt(e.target.value);
    if(val >= 1 && val <= 7) {
        custom_call_threshold = val;
    } else {
        e.target.value = custom_call_threshold; 
    }
});

// V10: 회피존 분산 추가 로직
document.getElementById('btn-add-siding').addEventListener('click', () => {
    // 0번은 기본 1180 위치이므로, 추가된 인덱스는 extra_sidings.length - 1
    let nextIndex = extra_sidings.length - 1;
    if (nextIndex < SIDING_GAP_ORDER.length) {
        extra_sidings.push({x: SIDING_GAP_ORDER[nextIndex], y: DOCKING_Y, type: 'EXTRA'});
    }
});

document.getElementById('btn-reset-siding').addEventListener('click', () => {
    extra_sidings = [{x: 1180, y: DOCKING_Y, type: 'EXTRA'}];
});

document.getElementById('btn-amr1').addEventListener('click', (e) => {
    setActive('#btn-amr1, #btn-amr2, #btn-amr3, #btn-amr4', e.target);
    resetAmrAssignments();
    amrs = [new AMR(0, COLOR_AMR[0])];
});

document.getElementById('btn-amr2').addEventListener('click', (e) => {
    setActive('#btn-amr1, #btn-amr2, #btn-amr3, #btn-amr4', e.target);
    resetAmrAssignments();
    amrs = [new AMR(0, COLOR_AMR[0]), new AMR(1, COLOR_AMR[1])];
});

document.getElementById('btn-amr3').addEventListener('click', (e) => {
    setActive('#btn-amr1, #btn-amr2, #btn-amr3, #btn-amr4', e.target);
    resetAmrAssignments();
    amrs = [new AMR(0, COLOR_AMR[0]), new AMR(1, COLOR_AMR[1]), new AMR(2, COLOR_AMR[2])];
});

document.getElementById('btn-amr4').addEventListener('click', (e) => {
    setActive('#btn-amr1, #btn-amr2, #btn-amr3, #btn-amr4', e.target);
    resetAmrAssignments();
    amrs = [new AMR(0, COLOR_AMR[0]), new AMR(1, COLOR_AMR[1]), new AMR(2, COLOR_AMR[2]), new AMR(3, COLOR_AMR[3])];
});

document.getElementById('btn-reset').addEventListener('click', () => {
    init();
    let activeAmrBtn = document.querySelector('#btn-amr1.active, #btn-amr2.active, #btn-amr3.active, #btn-amr4.active');
    if (activeAmrBtn) {
        activeAmrBtn.click();
    }
});

init();
loop();
