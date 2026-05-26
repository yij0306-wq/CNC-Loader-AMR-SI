const canvas = document.getElementById('simCanvas');
const ctx = canvas.getContext('2d');

const WIDTH = 1300;
const HEIGHT = 750;
const NUM_CNC = 13;
// Total process time based on 60fps = 90 mins scaled down. 
// Python code had TOTAL_PROCESS_TIME = 90 * 60 = 5400.
const TOTAL_PROCESS_TIME = 5400; 
const TRAY_INTERVAL = TOTAL_PROCESS_TIME / 8;

const AMR_LANE_Y = 330;
const PED_LANE_Y = 380;
const INPUT_ZONE = {x: 100, y: 550};
const OUTPUT_ZONE = {x: 1200, y: 150};

const COLOR_AMR_LANE = '#e6e6fa'; // 연보라 느낌의 차로
const COLOR_PED_LANE = '#f5f5f5'; // 옅은 회색 보행자
const COLOR_CNC_WORK = '#16a34a'; // Green 600
const COLOR_CNC_DONE = '#dc2626'; // Red 600
const COLOR_AMR = ['#2563eb', '#f97316']; // Blue 600, Orange 500

class SimulationManager {
    constructor() {
        this.speed = 1;
    }
}

class CNC {
    constructor(id, x) {
        this.id = id;
        this.x = x;
        this.y = 150;
        this.status = "RUNNING";
        this.elapsed_time = 0;
        this.trays = 0;
    }

    update(speed) {
        if (this.status === "RUNNING") {
            this.elapsed_time += speed;
            this.trays = Math.min(8, Math.floor(this.elapsed_time / TRAY_INTERVAL));
            if (this.elapsed_time >= TOTAL_PROCESS_TIME) {
                this.status = "DONE";
            }
        } else if (this.status === "IDLE" && this.trays === 0) {
            // 적당한 확률로 재시작
            if (Math.random() < 0.005 * speed) {
                this.status = "RUNNING";
            }
        }
    }

    draw(ctx) {
        let color = this.status === "RUNNING" ? COLOR_CNC_WORK : (this.status === "DONE" ? COLOR_CNC_DONE : '#94a3b8');
        
        // 설비 외함 (그림자 효과 추가)
        ctx.shadowColor = 'rgba(0,0,0,0.1)';
        ctx.shadowBlur = 4;
        ctx.fillStyle = '#cbd5e1';
        ctx.fillRect(this.x - 35, this.y - 40, 70, 90);
        ctx.shadowBlur = 0; // 그림자 초기화
        
        // 설비 내부 작업 영역
        ctx.fillStyle = color;
        ctx.fillRect(this.x - 30, this.y - 35, 60, 80);
        
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 2;
        ctx.strokeRect(this.x - 35, this.y - 40, 70, 90);

        // 8단 트레이 적층 시각화 (물리적 높이 표현)
        for (let i = 0; i < this.trays; i++) {
            ctx.fillStyle = '#facc15'; // 노란색 트레이
            // 쌓일수록 위로 올라가는 Y좌표
            let trayY = this.y + 35 - (i * 9);
            ctx.fillRect(this.x - 25, trayY, 50, 7);
            ctx.strokeStyle = '#ca8a04';
            ctx.lineWidth = 1;
            ctx.strokeRect(this.x - 25, trayY, 50, 7);
        }

        // 라벨 텍스트
        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 12px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`CNC-${this.id + 1}`, this.x, this.y - 50);
        ctx.fillText(`(${this.trays}/8T)`, this.x, this.y + 65);
    }
}

class AMR {
    constructor(id, color) {
        this.id = id;
        this.color = color;
        this.pos = { ...INPUT_ZONE };
        this.target = null;
        this.state = "WAITING"; 
        this.speed = 3;
        this.lane_y = AMR_LANE_Y;
        this.priority = id;
        this.payload = 0;
        this.target_cnc = null;
        this.angle = 0; // 회전 각도
    }

    move(manager, others) {
        if (!this.target) return;

        let step = this.speed * manager.speed;

        // 충돌 회피 알고리즘
        for (let other of others) {
            if (other.id !== this.id) {
                let dist = Math.hypot(this.pos.x - other.pos.x, this.pos.y - other.pos.y);
                if (dist < 45 && this.priority > other.priority) {
                    if (this.pos.y >= this.lane_y) this.pos.y += 2;
                    else this.pos.y -= 2;
                    return;
                }
            }
        }

        // Manhattan Routing (직각 이동 동선)
        let targetAngle = this.angle;
        
        // 1. 통로 진입 전 && 도킹중이 아닐 경우 Y축으로 통로까지 우선 이동
        if (Math.abs(this.pos.y - this.lane_y) > step && this.state !== "MOVING_TO_CNC_DOCK") {
            if (this.pos.y > this.lane_y) {
                this.pos.y -= step;
                targetAngle = -Math.PI / 2; // 위쪽
            } else {
                this.pos.y += step;
                targetAngle = Math.PI / 2; // 아래쪽
            }
        } 
        // 2. 통로 진입 후 X축으로 목표 지점까지 횡이동
        else if (Math.abs(this.pos.x - this.target.x) > step) {
            if (this.pos.x < this.target.x) {
                this.pos.x += step;
                targetAngle = 0; // 오른쪽
            } else {
                this.pos.x -= step;
                targetAngle = Math.PI; // 왼쪽
            }
        }
        // 3. 목적지 X에 도달 후 Y축으로 목표 지점까지 종이동 (도킹 등)
        else if (Math.abs(this.pos.y - this.target.y) > step) {
            if (this.pos.y > this.target.y) {
                this.pos.y -= step;
                targetAngle = -Math.PI / 2;
            } else {
                this.pos.y += step;
                targetAngle = Math.PI / 2;
            }
        } else {
            // 목적지 도달
            this.pos.x = this.target.x;
            this.pos.y = this.target.y;
        }

        // 부드러운 회전(Lerp) 적용
        let dAngle = targetAngle - this.angle;
        // 최단 방향 회전을 위한 각도 정규화 (-PI ~ PI)
        while (dAngle > Math.PI) dAngle -= Math.PI * 2;
        while (dAngle < -Math.PI) dAngle += Math.PI * 2;
        this.angle += dAngle * 0.15 * manager.speed;
    }

    draw(ctx) {
        ctx.save();
        ctx.translate(this.pos.x, this.pos.y);
        ctx.rotate(this.angle);

        // AMR 본체 (AGV 스타일)
        ctx.shadowColor = 'rgba(0,0,0,0.2)';
        ctx.shadowBlur = 6;
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.roundRect(-20, -15, 40, 30, 6);
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.lineWidth = 2;
        ctx.strokeStyle = '#1e293b';
        ctx.stroke();

        // 방향 지시등 (앞쪽 LED)
        ctx.fillStyle = '#fef08a'; // Glowing yellow
        ctx.beginPath();
        ctx.arc(15, -8, 3, 0, Math.PI * 2);
        ctx.arc(15, 8, 3, 0, Math.PI * 2);
        ctx.fill();

        // 바퀴 (4륜)
        ctx.fillStyle = '#334155';
        ctx.fillRect(-15, -18, 10, 4);
        ctx.fillRect(-15, 14, 10, 4);
        ctx.fillRect(5, -18, 10, 4);
        ctx.fillRect(5, 14, 10, 4);

        // 적재된 트레이 시각화
        if (this.payload > 0) {
            ctx.fillStyle = '#facc15';
            ctx.fillRect(-10, -10, 20, 20); // 상단에서 본 트레이 스택
            ctx.strokeStyle = '#ca8a04';
            ctx.strokeRect(-10, -10, 20, 20);
            
            // 텍스트는 회전하지 않도록 캔버스 복구 후 그리기 위해 각도 역연산
            ctx.rotate(-this.angle);
            ctx.fillStyle = '#0f172a';
            ctx.font = 'bold 10px Inter';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`${this.payload}T`, 0, 0);
        }

        ctx.restore();
        
        // 짐이 없을 땐 기체 번호 표시
        if (this.payload === 0) {
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 12px Inter';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`A${this.id+1}`, this.pos.x, this.pos.y);
        }
    }
}

let manager = new SimulationManager();
let cncs = [];
let amrs = [];

function init() {
    cncs = [];
    amrs = [];
    for (let i = 0; i < NUM_CNC; i++) {
        cncs.push(new CNC(i, 100 + i * 90));
    }
    amrs.push(new AMR(0, COLOR_AMR[0]));
    
    // 빠른 테스트를 위해 일부 설비 작업량 조작
    cncs[0].elapsed_time = TOTAL_PROCESS_TIME - 100;
    cncs[3].elapsed_time = TOTAL_PROCESS_TIME / 2;
}

function update() {
    cncs.forEach(cnc => cnc.update(manager.speed));

    amrs.forEach(amr => {
        if (amr.state === "WAITING") {
            for (let c of cncs) {
                if (c.status === "DONE") {
                    amr.target = {x: c.x, y: c.y + 70}; // 설비 앞 도킹 포인트
                    amr.target_cnc = c;
                    amr.state = "MOVING_TO_CNC_LANE";
                    c.status = "IDLE"; // 다른 AMR이 오지 못하도록 소유권 설정
                    break;
                }
            }
        } else if (amr.state === "MOVING_TO_CNC_LANE") {
            // 1. 통로 진입 및 X 좌표 이동
            amr.target = {x: amr.target_cnc.x, y: AMR_LANE_Y};
            amr.move(manager, amrs);
            if (Math.abs(amr.pos.x - amr.target.x) < 5 && Math.abs(amr.pos.y - amr.target.y) < 5) {
                amr.state = "MOVING_TO_CNC_DOCK";
            }
        } else if (amr.state === "MOVING_TO_CNC_DOCK") {
            // 2. 설비로 도킹 (Y축 수직이동)
            amr.target = {x: amr.target_cnc.x, y: amr.target_cnc.y + 70};
            amr.move(manager, amrs);
            if (Math.abs(amr.pos.x - amr.target.x) < 5 && Math.abs(amr.pos.y - amr.target.y) < 5) {
                amr.payload = amr.target_cnc.trays;
                amr.target_cnc.trays = 0;
                amr.target_cnc.elapsed_time = 0;
                amr.state = "MOVING_TO_OUT_LANE";
            }
        } else if (amr.state === "MOVING_TO_OUT_LANE") {
            // 3. 통로 복귀 및 아웃풋 X 좌표 이동
            amr.target = {x: OUTPUT_ZONE.x, y: AMR_LANE_Y};
            amr.move(manager, amrs);
            if (Math.abs(amr.pos.x - amr.target.x) < 5 && Math.abs(amr.pos.y - amr.target.y) < 5) {
                amr.state = "MOVING_TO_OUT_DOCK";
            }
        } else if (amr.state === "MOVING_TO_OUT_DOCK") {
            // 4. 아웃풋 도킹
            amr.target = { ...OUTPUT_ZONE };
            amr.move(manager, amrs);
            if (Math.abs(amr.pos.x - amr.target.x) < 5 && Math.abs(amr.pos.y - amr.target.y) < 5) {
                amr.payload = 0;
                amr.state = "RETURNING";
            }
        } else if (amr.state === "RETURNING") {
            // 5. 인풋 방향 통로 주행
            amr.target = {x: INPUT_ZONE.x, y: AMR_LANE_Y};
            amr.move(manager, amrs);
            if (Math.abs(amr.pos.x - amr.target.x) < 5 && Math.abs(amr.pos.y - amr.target.y) < 5) {
                amr.target = { ...INPUT_ZONE };
                amr.state = "RETURNING_DOCK";
            }
        } else if (amr.state === "RETURNING_DOCK") {
            // 6. 인풋 존 도착 및 대기
            amr.target = { ...INPUT_ZONE };
            amr.move(manager, amrs);
            if (Math.abs(amr.pos.x - amr.target.x) < 5 && Math.abs(amr.pos.y - amr.target.y) < 5) {
                amr.state = "WAITING";
            }
        }
    });
}

function draw() {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    // 통로 구획 (Lanes)
    ctx.fillStyle = COLOR_AMR_LANE;
    ctx.fillRect(0, 310, WIDTH, 50);
    ctx.fillStyle = COLOR_PED_LANE;
    ctx.fillRect(0, 360, WIDTH, 50);
    
    // 보행자 통로 침범 금지 점선 (Strict Line)
    ctx.beginPath();
    ctx.moveTo(0, 360);
    ctx.lineTo(WIDTH, 360);
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 5]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#64748b';
    ctx.font = 'bold 14px Inter';
    ctx.textAlign = 'left';
    ctx.fillText("AMR DEDICATED LANE", 20, 340);
    ctx.fillStyle = '#ef4444';
    ctx.fillText("PEDESTRIAN ZONE (STRICT NO AMR)", 20, 390);

    // 구역 표시 (Zones)
    const drawZone = (zone, color, label) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(zone.x - 50, zone.y - 50, 100, 100, 12);
        ctx.fill();
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        ctx.fillStyle = '#0f172a';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 16px Inter';
        ctx.fillText(label, zone.x, zone.y);
    };

    drawZone(INPUT_ZONE, '#fde68a', 'INPUT');
    drawZone(OUTPUT_ZONE, '#bfdbfe', 'OUTPUT');

    // 엔티티 그리기
    cncs.forEach(cnc => cnc.draw(ctx));
    amrs.forEach(amr => amr.draw(ctx));
}

function loop() {
    update();
    draw();
    requestAnimationFrame(loop);
}

// 이벤트 리스너 (UI 버튼 제어)
const setActive = (group, target) => {
    document.querySelectorAll(group).forEach(b => b.classList.remove('active'));
    target.classList.add('active');
};

document.getElementById('btn-1x').addEventListener('click', (e) => { manager.speed = 1; setActive('#btn-1x, #btn-10x, #btn-20x', e.target); });
document.getElementById('btn-10x').addEventListener('click', (e) => { manager.speed = 10; setActive('#btn-1x, #btn-10x, #btn-20x', e.target); });
document.getElementById('btn-20x').addEventListener('click', (e) => { manager.speed = 20; setActive('#btn-1x, #btn-10x, #btn-20x', e.target); });

document.getElementById('btn-amr1').addEventListener('click', (e) => {
    setActive('#btn-amr1, #btn-amr2', e.target);
    amrs = [new AMR(0, COLOR_AMR[0])];
});

document.getElementById('btn-amr2').addEventListener('click', (e) => {
    setActive('#btn-amr1, #btn-amr2', e.target);
    amrs = [new AMR(0, COLOR_AMR[0]), new AMR(1, COLOR_AMR[1])];
});

// 시뮬레이션 시작
init();
loop();
