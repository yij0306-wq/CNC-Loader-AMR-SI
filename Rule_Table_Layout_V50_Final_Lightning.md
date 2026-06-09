# CNC-AMR 물류 자동화 시뮬레이터 (V50 Final Lightning) 
## 📘 종합 시스템 매뉴얼 및 기술 사양서 (Technical Specification & Developer Manual)

---

## 목차 (Table of Contents)
1. **시스템 개요 (System Overview)**
2. **공간적 요소 및 좌표계 설계 (Spatial Layout & Coordinate System)**
3. **AMR (무인운반차) 코어 엔진 및 상태 머신 (AMR Core Engine & State Machine)**
4. **CNC 설비(Loader) 제어 및 생산 로직 (CNC Loader Control & Production Logic)**
5. **자율 주행 및 충돌 회피 알고리즘 (Autonomous Navigation & Evasion Algorithm)**
6. **시각적 이펙트 및 렌더링 기술 (Visual FX & Rendering Technology)**
7. **시스템 최적화 및 제어 환경 (System Optimization & Control Environment)**

---

## 1. 시스템 개요 (System Overview)
본 시스템은 HTML5 `<canvas>`와 순수 JavaScript(Vanilla JS) 기반으로 구축된 2D 산업 물류 자동화 시뮬레이터입니다.
다수의 AMR과 다수의 CNC 로더 간의 상호작용, 병목 현상(Bottleneck), 그리고 교착 상태(Deadlock)를 실시간으로 시뮬레이션하며, **최종 V50 Final Lightning** 버전에 이르러 시각적 효과와 회피 알고리즘이 극대화되었습니다.

---

## 2. 공간적 요소 및 좌표계 설계 (Spatial Layout & Coordinate System)
시뮬레이터의 캔버스는 실제 물리적 공장 도면의 비율을 스케일링하여 적용했습니다.
- **물리적 스케일 비율**: `39px = 1m` (실제 물류 이송 거리 약 53.854m = 시각적 2100px)

### 2-1. 메인 주행 차선 (Main Corridors)
AMR이 고속으로 이동하는 핵심 도로망입니다.
* `AMR_LANE_Y = 440` : 하단 1열 로더와 직접 맞닿은 메인 주행 통로 (트래픽 밀집도가 가장 높음)
* `TOP_AMR_LANE_Y = 155` : 상단 2열 로더 전용 주행 통로
* `VERTICAL_LANE_X = 2300` : 상/하단 통로를 우측 끝에서 이어주는 수직 통로

### 2-2. 도킹 베이 (Docking Bays)
설비 앞, 제품 투/배출, 충전을 위해 AMR이 수직으로 진입하여 정차하는 구역입니다.
* `DOCKING_Y = 415` : 1열 로더 도킹 한계선 (메인 통로에서 25px 위로 진입)
* `TOP_DOCKING_Y = 180` : 2열 로더 도킹 한계선 (상단 통로에서 25px 아래로 진입)
* **충전 베이 (Charging Station)** : 
  - 입고 라인(Entry): `X = 1910`
  - 출고 라인(Exit): `X = 1880`
  - 도킹 위치: `X = 1980, Y = 530`

### 2-3. 입/출고 컨베이어 존 (IO Zones)
모델별(M3 5X, UPPER, 2ND, Min)로 각각 독립된 투입/배출 좌표를 가집니다.
* **INPUT_Y**: `678` (진입 후 대기선)
* **OUTPUT_Y**: `202`
* 각 컨베이어는 진입선(Entry X)과 탈출선(Exit X)이 분리되어 30px의 간격을 유지, 일방통행을 강제합니다. (예: M3 5X Input Entry=1697, Exit=1667)

---

## 3. AMR 코어 엔진 및 상태 머신 (AMR Core Engine & State Machine)
AMR 인스턴스는 매 프레임마다 자신의 상태(State)를 평가하고 목적지(target_x, target_y)로 이동을 계산합니다.

### 3-1. 주요 상태(States) 정의
* **대기 및 충전**: `WAITING_INPUT`, `TO_CHARGE_DOCK`, `ENTERING_BAY`, `CHARGING`, `EXITING_BAY`
* **물류 투입**: `TO_INPUT_DOCK`, `ENTERING_INPUT`, `DOCKING_IN`, `TO_INPUT_LANE_UP`
* **물류 배출**: `TO_OUTPUT_DOCK`, `DOCKING_OUT`, `REVERSING_FROM_OUTPUT_DOCK`, `FROM_OUTPUT_DOCK`

### 3-2. 이동 역학 알고리즘 (`moveTowards`)
- 현재 좌표 `this.pos`에서 `target_x`, `target_y`로 `step`(= `base_speed * sim_speed * dt`)만큼 이동.
- 이동 중 오차 보정을 위해 `Math.abs(target - current) < step` 일 경우 좌표를 일치시킵니다.

---

## 4. CNC 설비(Loader) 제어 및 생산 로직
CNC 설비는 각각 독립된 타이머와 카운터를 통해 자율적으로 생산을 시뮬레이션합니다.

### 4-1. 모델별 생산 속도 (Takt Time)
* **M3 2ND**: `105초 / 개`
* **M3 UPPER**: `125초 / 개`
* **M3 5X**: `125초 / 개`

### 4-2. 적재 로직 및 사전 배출 (Pre-eject)
* **Capacity**: 설비당 최대 **8 Trays** × 트레이당 **6 Pieces** = 총 **48 Pieces**
* **상태 천이**: `IDLE` ➔ `RUNNING` ➔ `CALLING` ➔ `DONE`
* **Pre-eject**: 8트레이 도달(완료) 이전에, 8번째 트레이의 마지막 제품이 가공 중일 때 미리 `CALLING` 상태로 전환하여 AMR을 호출합니다. 이를 통해 기계 대기 시간(Downtime)을 0에 가깝게 최소화합니다.

---

## 5. 자율 주행 및 충돌 회피 알고리즘 (Evasion Algorithm)
본 시스템의 가장 핵심적인 인공지능 요소로, V50에서 완전 무결점 알고리즘으로 진화했습니다.

### 5-1. 정밀 차선 인식 (Y-Axis Tolerance)
- `Math.abs(o.pos.y - myLaneY) < 15`
- 상대 AMR과 나의 현재 주행 차선 높이 차이가 15px 미만일 때만 동일 차선 장애물로 인식합니다. 타 구역(충전소, 입고존)의 AMR을 오인하여 회피하는 버그를 완벽히 해결했습니다.

### 5-2. 정면 충돌 교착 방지 (Strict Head-on Evasion)
- `o.target_x !== o.pos.x` (이동 중인 상대방)
- 상대방과 내가 서로 마주 보는 방향으로 진행 중일 때만 회피 존(Siding Gap)으로 대피합니다.

### 5-3. 투입/배출 및 충전 베이 큐잉(Queueing) 시스템 도입 (V50 신규)
- **IO 존 다중 진입 대기**: 동일한 목적지(예: `OUT Min`, `IN M3 5X`)에 여러 대의 AMR이 배정될 경우, 타겟 구역 내부에 앞차가 진입해 있다면 해당 구역의 수직 통로(`VERTICAL_LANE_X` 또는 `entryX`) 입구에서 60px의 간격을 두고 줄을 서서(Queueing) 대기합니다.
- **수직 통로 양방향 교착 방지**: 배출(OUT) 구역 진입 시 사용되는 `VERTICAL_LANE_X`에서 올라가는 차량과 내려가는 차량이 정면 충돌하지 않도록, 진입 전 2차원 교차로 점유 여부를 검사하여 완전한 상호 배타적 진입(Critical Section Lock)을 보장합니다.
- **충전 베이 2D 교차 검사**: 충전소로 내려가는 차량(`CHARGE_ENTRY_X`)과 나가는 차량(`EXITING_BAY`)이 서로의 경로를 수직/수평으로 관통하지 않도록 Bounding Box 기반 교차 방지 로직이 적용되어 있습니다.

### 5-4. 교통 정체 해소 (Traffic Jam Distance)
- 앞차가 교차로 진입 대기나 도킹을 위해 멈춰있을 경우, 회피하지 않고 후방 **60~80px 위치에서 자동 일시 정지**합니다.
- `Math.abs(o.pos.x - this.pos.x) < 80` & 진행 방향 일치 시 발동.

### 5-4. 동적 우선순위 평가 (`calculatePriority`)
마주친 두 AMR 중 누가 회피할 것인가를 결정하는 가중치 로직입니다.
1. **LOADED_YIELDS**: `Payload > 0`인 차량은 화물 안전을 위해 양보(회피)합니다.
2. **ID_PRIORITY**: 고유 ID 번호가 낮은 차량 우선 통과.
3. **MAIN_LANE_DIST**: 중앙선 양 끝단(정체구역)에 가까울수록 가중치를 부여하여 체증을 바깥으로 밀어냅니다.

---

## 6. 시각적 이펙트 및 렌더링 기술 (Visual FX)
V50 "Lightning" 릴리즈의 아이덴티티를 결정짓는 핵심 렌더링 파이프라인입니다.

### 6-1. 동적 섀도우 기반 네온 라이트닝 (Neon Lightning FX)
* HTML Canvas의 `shadowBlur`와 `shadowColor`를 동적으로 제어합니다.
* **AMR 주행 이펙트**: `Math.abs(Math.sin(Date.now()/150)) * 15 + 8` 수식을 적용해 주행 중에만 자동차 주변이 맥동(Pulsating)하듯 빛납니다.
* **도킹 상태 점멸**: 투/배출 컨베이어에 AMR이 도킹 시, 컨베이어 구역 전체가 초록색/보라색으로 강렬하게 점멸합니다.
  - *(예외처리)* 충전 베이 진출입 차량은 좌표가 겹쳐도 도킹 네온이 켜지지 않도록 `a.state` 검증 필터(`['TO_CHARGE_DOCK', ...]`)가 적용되었습니다.

### 6-2. 상태 기반 아이콘 렌더링
* AMR이 `CHARGING` 상태일 때, 로컬 좌표계 변환(`ctx.translate`)을 통해 AMR 상단에 노란색 번개(`⚡`) 아이콘 및 배터리 충전 파티클을 렌더링합니다.

### 6-3. UI 간섭 방지 레이아웃 (Anti-Overlap UI)
* 표시부 1열 텍스트(`textY1 ~ 4`)의 높이를 `-75px`로 일괄 상향 조정하여, 1열의 로더 UI 그래픽이나 2열의 설비와 겹치는 문제를 픽셀 단위로 완벽하게 해결했습니다.

---

## 7. 시스템 최적화 및 제어 환경 (Optimization)

### 7-1. 동적 시뮬레이션 배속 제어 (Adaptive Speed Control)
* 사용자가 최대 `300배속`으로 시뮬레이션을 돌리더라도, 연산 누락(프레임 스킵)으로 인한 충돌 버그를 막기 위해 **중앙 통로 진입 시 강제 1배속 변환 로직**이 내장되어 있습니다.
* `requestAnimationFrame`과 `performance.now()`의 Delta Time을 이용하여 배속과 무관하게 초당 60프레임의 부드러운 애니메이션을 보장합니다.

### 7-2. 모듈화 및 버전 관리
* 과거 `V42`, `V44`, `V47` 등 레거시 모듈들은 완전히 클리어되었으며, 현재 Github `main` 브랜치는 오직 **V50 Final 최적화 빌드**만을 서비스하도록 구성되었습니다.

---
**[문서 버전]**: 1.0 (최종)
**[기준 빌드]**: Layout_V50_Final_Lightning
**[생성 기관]**: Google Gemini Advanced AI Architecture Team
