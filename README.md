# Cloud Media Server & Zero-Trust Defense Network (k3s on OCI)

> **Oracle Cloud Always Free ARM(Ampere A1) 환경에 구축한 k3s 기반 미디어 스트리밍 서버 및 이중 방화벽(Screening + Choke) 보안 검증 프로젝트**

![Oracle Cloud](https://img.shields.io/badge/Oracle%20Cloud-ARM64%20Always%20Free-F80000?style=flat-square&logo=oracle&logoColor=white)
![Ubuntu](https://img.shields.io/badge/Ubuntu-24.04%20Minimal%20aarch64-E95420?style=flat-square&logo=ubuntu&logoColor=white)
![k3s](https://img.shields.io/badge/Kubernetes-k3s%20Single%20Node-326CE5?style=flat-square&logo=kubernetes&logoColor=white)
![Jellyfin](https://img.shields.io/badge/Media-Jellyfin-00A4DC?style=flat-square&logo=jellyfin&logoColor=white)
![rclone](https://img.shields.io/badge/Storage-rclone%20(pCloud)-3B82F6?style=flat-square)
![NetworkPolicy](https://img.shields.io/badge/Security-Zero--Trust%20NetworkPolicy-10B981?style=flat-square)

---

## 목차 (Table of Contents)

- [1. 프로젝트 배경 및 목표](#1-프로젝트-배경-및-목표)
- [2. 전체 아키텍처 (Architecture)](#2-전체-아키텍처-architecture)
- [3. 클라우드 인프라 스펙 명세 (Infrastructure Spec)](#3-클라우드-인프라-스펙-명세-infrastructure-spec)
- [4. 단계별 구축 기록 및 트러블슈팅 (Implementation Log)](#4-단계별-구축-기록-및-트러블슈팅-implementation-log)
- [5. 디렉토리 구조 (Repository Structure)](#5-디렉토리-구조-repository-structure)
- [6. 진행 현황 및 로드맵 (Roadmap Checklist)](#6-진행-현황-및-로드맵-roadmap-checklist)

---

## 1. 프로젝트 배경 및 목표

| 구분 | 목표 및 구현 전략 |
| :--- | :--- |
| **미디어 스트리밍** | pCloud에 저장된 대용량 애니메이션/자막 원본을 복제 없이 `rclone` VFS 스트리밍으로 마운트하여, 어디서든 Jellyfin으로 원활하게 시청 |
| **이중 방화벽 실습** | 전통적인 네트워크 보안 모델인 **Screening Firewall + DMZ + Choke Firewall + Internal LAN** 구조를 Kubernetes 네임스페이스와 `NetworkPolicy`로 구현하고 `nmap` 침투 테스트로 검증 |
| **관측 가능성** | Prometheus & Grafana를 내부 구역(`internal`)에 배치해 노드 자원, 디스크 캐시, 서비스 상태를 모니터링 (외부 노출 차단) |
| **비용 0원 유지** | 전체 구성을 **Oracle Cloud Always Free** 한도(Ampere A1 2 OCPU / 12GB RAM / 200GB 스토리지) 내에서 운용 |

---

## 2. 전체 아키텍처 (Architecture)

### 2.1 구현 아키텍처 흐름도

```mermaid
flowchart LR
    User["외부 사용자<br/>(폰 · TV · PC)"] -->|"80 / 443 (HTTPS)"| SL["OCI Security List + iptables<br/>[Screening Firewall · 1차 방어]"]
    Admin["관리자 (내 PC)"] -->|"22 (SSH, 내 IP만)"| SL
    SL --> ING

    subgraph VM["Oracle VM (k3s-main) · Ampere A1 2 OCPU / 12GB / 100GB"]
        subgraph DMZ["namespace: dmz (Screened Subnet)"]
            ING["Traefik Ingress"] --> JF["Jellyfin Pod"]
        end

        RC["rclone VFS Mount (호스트)<br/>/mnt/pcloud (read-only · max 30GB)"]
        JF -->|"hostPath (ro)"| RC

        NP["Kubernetes NetworkPolicy<br/>[Choke Firewall · 2차 방어 (Default-Deny)]"]

        subgraph INT["namespace: internal (내부 격리망)"]
            API["내부 API Pod (연습/검증용)"]
            DB["내부 DB Pod (비공개 타겟)"]
            MON["Prometheus + Grafana"]
        end

        JF -.->|"허용 포트만 통과"| NP --> API
        JF -.->|"❌ 차단"| DB
        JF -.->|"❌ 차단"| MON
    end

    RC -->|"필요 시 블록 스트리밍"| PC["pCloud<br/>(애니 · 자막 원본)"]
```

### 2.2 이중 방화벽 개념 매핑

| 보안 계층 개념 | 이 프로젝트에서의 실제 구현 | 역할 |
| :--- | :--- | :--- |
| **Screening Firewall (1차 방어)** | **OCI Security List** + Ubuntu `iptables` | 외부에서 유입되는 트래픽 중 허용된 포트(22, 80, 443)만 통과 |
| **Screened Subnet (DMZ)** | Kubernetes `dmz` 네임스페이스 (`Traefik`, `Jellyfin`) | 인터넷에 노출되는 서비스만 격리 배치 |
| **Choke Firewall (2차 방어)** | Kubernetes **NetworkPolicy** (`Default-Deny`) | DMZ 서비스가 탈취되더라도 내부 구역으로의 횡적 이동(Lateral Movement) 차단 |
| **Internal LAN (내부망)** | Kubernetes `internal` 네임스페이스 (`API`, `DB`, `Grafana`) | 외부 직접 접근이 차단된 내부 서비스 및 모니터링 계층 |

### 2.3 초기 설계 구상도 (멀티 노드 참조 모델 → 단일 노드 최적화)

> 초기 멀티 노드(VM 3대) 구상안을 2026년 6월 개정된 OCI Always Free 한도(2 OCPU / 12GB)에 맞춰 단일 노드 네임스페이스 분리(B안)로 최적화했습니다.

![초기 아키텍처 구상도](./01_architecture/network_diagram.jpg)

---

## 3. 클라우드 인프라 스펙 명세 (Infrastructure Spec)

| 항목 | 구성 상세 | 비고 |
| :--- | :--- | :--- |
| **클라우드 환경** | Oracle Cloud Infrastructure (OCI) | US West (San Jose) 홈 리전 |
| **인스턴스명** | `k3s-main` | k3s 단일 노드 클러스터 |
| **컴퓨트 셰이프** | `VM.Standard.A1.Flex` (Ampere Neoverse N1 ARM64) | 서버용 고성능 ARM 프로세서 |
| **CPU / 메모리** | **2 OCPU (물리 2코어) / 12 GB RAM** | Always Free 상한 100% 활용 |
| **네트워크 대역폭** | **2 Gbps** | 고화질 스트리밍 병목 없음 |
| **부트 볼륨** | **100 GB** (총 200 GB 무료 풀 내) | rclone VFS 캐시 최대 30 GB 제한 예정 |
| **운영체제 (OS)** | Canonical Ubuntu 24.04 Minimal `aarch64` | 경량화 이미지 |
| **사설 IP (Private)** | `10.0.0.5` | VCN `k3s-vcn` / Subnet `k3s-subnet` |
| **공인 IP (Public)** | `147.224.xx.xx` (Ephemeral IPv4) | GitHub 공개 보안을 위해 일부 마스킹 처리 |

---

## 4. 단계별 구축 기록 및 트러블슈팅 (Implementation Log)

### 4.1 OCI ARM 용량 부족(`Out of host capacity`) 돌파

* **문제 상황**: US West (San Jose) 리전에서 무료 Ampere A1 인스턴스 생성 시 `500-InternalError: Out of host capacity` 오류가 지속 발생.
* **해결 전략**:
  1. 오라클 콘솔 UI의 `Create` 버튼(`button[aria-label="Create"]`)을 직접 탐색·클릭하는 브라우저 콘솔 자동화 스크립트([`oci_auto_creator_macro.js`](./02_infrastructure_oci/oci_auto_creator_macro.js))를 작성해 30초 주기로 생성 요청 자동화.
  2. 리소스 확보 확률을 높이기 위해 **1 OCPU / 6GB** 최소 단위로 먼저 인스턴스를 확보한 뒤, Pay As You Go 전환 및 리소스 확장을 통해 **2 OCPU / 12GB**로 스케일업 완료.
  3. 성공 후 인스턴스 상세 URL(`/instances/ocid1.`) 전환을 감지해 매크로가 자동 종료되도록 안전장치 구현.

![자동 생성 매크로 실행 로그](./02_infrastructure_oci/screenshots/01_macro_automation.png)

---

### 4.2 공인 IP 동적 바인딩 및 2 OCPU / 12GB 스케일업 검증

인스턴스 초기 생성 당시 VCN/서브넷 설정 이슈로 공인 IP가 미할당 상태였으나, Primary VNIC의 **IP administration** 설정에서 Ephemeral Public IPv4(`147.224.xx.xx`)를 동적으로 바인딩했습니다. 이후 셰이프 스케일업을 거쳐 **2 OCPU / 12GB RAM / 2Gbps 대역폭**으로 정상 가동(`Running`)되는 것을 확인했습니다.

| ① VNIC 공인 IP 동적 할당 검증 | ② 2 OCPU / 12GB 스케일업 및 가동 검증 |
| :---: | :---: |
| ![공인 IP 할당 완료](./02_infrastructure_oci/screenshots/02_public_ip_assigned.png) | ![2 OCPU / 12GB 스케일업 검증](./02_infrastructure_oci/screenshots/03_instance_scaleup_verified.jpg) |

---

### 4.3 OS 베이스라인 구성 및 필수 유틸리티 7종 설치

불필요한 데몬과 패키지를 제거해 공격 표면(Attack Surface)과 메모리 점유율을 줄이기 위해 **Ubuntu 24.04 Minimal (`aarch64`)**을 채택하고, 운영 및 병목 분석에 필요한 핵심 도구 7종만 선별 설치했습니다.

```bash
sudo apt update && sudo apt install -y curl wget vim nano htop iotop net-tools
```

| 도구 | 설치 목적 및 활용 |
| :--- | :--- |
| `curl`, `wget` | k3s, rclone 설치 스크립트 및 REST API 테스트 |
| `vim`, `nano` | Kubernetes YAML 매니페스트 및 systemd 유닛 파일 편집 |
| `htop` | ARM 코어별 CPU 부하 및 메모리 사용량 실시간 확인 |
| `iotop` | rclone VFS 캐시 읽기/쓰기 시 디스크 I/O 병목 분석 |
| `net-tools` | `netstat`, `ifconfig`, 라우팅 및 리스닝 포트 상태 점검 |

---

### 4.4 OCI Ubuntu 내부 방화벽(`iptables`) 개방 및 K3s 대역 허용

> **설정 이유 — 정문(클라우드 콘솔) vs 현관문(`iptables`)**
> 일반 클라우드(AWS 등)의 우분투 이미지는 현관문(`iptables`)이 기본적으로 열려 있어 정문(클라우드 콘솔 방화벽)만 열면 통신이 됩니다. 반면 **Oracle Cloud(OCI) 우분투 이미지는 출고 시점부터 현관문(`iptables`)이 `22번(SSH)`을 제외한 모든 트래픽을 강제 거부(`REJECT --reject-with icmp-host-prohibited`)하도록 잠겨 있습니다.** 따라서 OCI 웹 콘솔(Security List)을 열더라도 OS 내부 `iptables`를 추가로 열어주지 않으면 외부 웹 접속과 K3s 내부 통신이 모두 차단됩니다.

| 변경 항목 | 규칙·위치 | 정확한 적용 이유 |
| :--- | :--- | :--- |
| **`80`, `443` 포트 허용** | `INPUT` 5·6번 (`REJECT` 위쪽) | 외부 폰·PC에서 Jellyfin에 접속하는 웹 표준 포트(HTTP `80` / HTTPS `443`)입니다. `iptables`는 위에서부터 번호 순서대로 규칙을 검사하므로, 마지막 `9번 REJECT`보다 **위쪽 번호**에 배치해야 통과됩니다. (미지정 포트는 여전히 9번 `REJECT`가 차단) |
| **K3s CIDR 대역 허용** | `INPUT` 7·8번 (`10.42.0.0/16`, `10.43.0.0/16`) | K3s 파드(`10.42.0.0/16`) 및 서비스(`10.43.0.0/16`) 전용 가상 IP 대역입니다. 허용하지 않으면 Jellyfin·Traefik·CoreDNS가 호스트 노드에 접근할 때 `REJECT`에 막혀 클러스터 네트워크가 동작하지 않습니다. |
| **`FORWARD` `REJECT` 해제** | `FORWARD` 체인 기본 차단 삭제 | 파드 간 통신(`Traefik` → `Jellyfin`) 및 파드의 외부 통신(`pCloud`)이 거치는 리눅스 `FORWARD` 통로의 기본 차단을 해제했습니다. 이후 파드 간 구역 통제는 **2차 방화벽(`NetworkPolicy`)**이 담당합니다. |

* **영구 저장 및 검증**: `sudo netfilter-persistent save`로 `/etc/iptables/rules.v4`에 반영(원본은 `/etc/iptables/rules.v4.bak` 백업) 완료

```bash
# 현재 INPUT 규칙 번호 순서 확인 (80, 443, K3s CIDR이 REJECT보다 위쪽인지 점검)
sudo iptables -L INPUT -n -v --line-numbers

# 원본(.bak) 대비 추가/삭제된 규칙 차이 비교
sudo diff -u /etc/iptables/rules.v4.bak /etc/iptables/rules.v4
```

![Ubuntu iptables rules.v4 설정 확인](./05_security_firewall/screenshots/01_iptables_rules_v4.png)

---

### 4.5 Screening Firewall (OCI Security List) 구성 및 K3s 설치 전 포트 테스트

현관문(`iptables`) 개방에 이어, **정문(OCI Virtual Cloud Network → `Default Security List for k3s-vcn`)**의 **`Ingress Rules`**에 웹 표준 포트 `80`·`443`을 추가했습니다.

* **왜 `Egress`가 아니라 `Ingress`를 열었는가?**
  * 방화벽 방향의 기준은 데이터 전송량이 아니라 **"누가 먼저 연결을 시작(`SYN`)하는가"**입니다. 외부 폰·PC가 Jellyfin에 먼저 접속해 오므로 `Ingress`(수신)에 `80`, `443`을 허용해야 합니다.
  * OCI Security List는 **Stateful(상태 기억)** 방화벽이므로 `Ingress`로 들어온 요청에 대한 영상 스트리밍 응답 트래픽은 별도 규칙 없이 자동 허용됩니다. (`Egress`는 이미 전체 허용 상태이며, `Source Port Range`는 클라이언트 임의 포트를 허용하기 위해 빈칸/`All`로 설정)
* **왜 `ping` 응답이 오지 않는가? (`ICMP` Type 차이)**
  * 기본 Security List에 `ICMP` 규칙이 보이지만 이는 **Type `3, 4`(Path MTU 등 오류 알림용)**만 허용합니다. 일반적인 `ping` 요청(**ICMP Type `8` Echo Request**)은 기본 차단 상태이므로, 외부 스캐너로부터 서버 생존 노출을 줄이기 위해 그대로 차단을 유지했습니다.

| ① OCI Security List Ingress(80·443) 규칙 추가 | ② 최종 반영된 Ingress Rules 테이블 |
| :---: | :---: |
| ![OCI Ingress 80/443 규칙 입력](./05_security_firewall/screenshots/02_oci_ingress_port_setup.png) | ![OCI Ingress Rules 반영 완료](./05_security_firewall/screenshots/03_oci_ingress_rules_table.png) |

* **K3s 설치 전 외부 포트 기준선(Baseline) 검증**
  * 외부에서 `curl`로 `80`·`443` 접속을 시도한 직후 VM에서 `sudo iptables -L INPUT -n -v --line-numbers`로 확인한 결과, 해당 규칙의 패킷 카운터(`pkts`)가 `0 → 5`(`80`), `0 → 3`(`443`)으로 증가해 **OCI 정문 → Ubuntu 현관문 통과가 정상 동작함을 확인**했습니다. (미허용 포트 `6443`은 OCI 정문에서 차단)
  * 아직 K3s(`Traefik`)가 설치되지 않아 `80`/`443`에서 응답(`SYN-ACK`)할 데몬이 없으므로, 로컬 PowerShell의 `Test-NetConnection`에서는 아래처럼 `TcpTestSucceeded : False`가 기록되며 **K3s 설치 직후 `True`로 전환되는 Before/After 기준선**으로 활용합니다.

![K3s 설치 전 80/443 포트 응답 대기 상태 확인](./03_kubernetes_k3s/screenshots/01_before_k3s_port_test.png)

---

## 5. 디렉토리 구조 (Repository Structure)

> ※ 보안 정책(`.gitignore`)에 따라 SSH 비밀키(`*.key`, `*.ppk`), 공개키(`*.pub`), 클라우드 인증 정보(`rclone.conf`)는 저장소에 업로드되지 않습니다.

```text
midea server/
├── .gitignore                        # SSH 키 및 rclone 인증 파일 업로드 차단
├── README.md                         # 프로젝트 마스터 포트폴리오 (현재 문서)
├── PORTFOLIO.md                      # 상세 작업 기록집
├── 01_architecture/                  # 아키텍처 다이어그램, 스펙 명세, 로드맵
│   ├── architecture_spec.md
│   ├── network_diagram.jpg
│   └── roadmap.md
├── 02_infrastructure_oci/            # OCI 프로비저닝 매크로 및 증빙 캡처
│   ├── oci_auto_creator_macro.js
│   └── screenshots/
│       ├── 01_macro_automation.png
│       ├── 02_public_ip_assigned.png
│       └── 03_instance_scaleup_verified.jpg
├── 03_kubernetes_k3s/                # k3s 매니페스트 및 클러스터 검증 캡처
│   ├── manifests/
│   └── screenshots/
│       └── 01_before_k3s_port_test.png
├── 04_storage_rclone/                # pCloud 마운트 서비스 및 VFS 캐시 가이드
│   └── screenshots/
├── 05_security_firewall/             # NetworkPolicy YAML 및 방화벽 검증 보고서
│   ├── network_policies/
│   └── screenshots/
│       ├── 01_iptables_rules_v4.png
│       ├── 02_oci_ingress_port_setup.png
│       └── 03_oci_ingress_rules_table.png
└── 06_monitoring_grafana/            # Prometheus/Grafana 설정 및 대시보드 캡처
    └── screenshots/
```

---

## 6. 진행 현황 및 로드맵 (Roadmap Checklist)

- [x] **Phase 0**: Oracle Cloud 가입 및 리전/이미지 선택 (`Ubuntu 24.04 Minimal aarch64`)
- [x] **Phase 1**: Ampere A1 인스턴스 확보, 공인 IP 할당(`147.224.xx.xx`), 2 OCPU / 12GB 스케일업
- [x] **Phase 2**: SSH 접속, OS 패키지 업그레이드·보안 업데이트(`unattended-upgrades`), `iptables` 80/443 및 K3s CIDR 허용(`netfilter-persistent save`) 완료
- [x] **Phase 3**: Screening Firewall (OCI Security List `Ingress` 80/443 개방, `iptables -L INPUT -v` 패킷 도달 및 K3s 설치 전 포트 기준선 확인) 완료
- [ ] **Phase 4**: k3s 단일 노드 클러스터 설치 및 `dmz` / `internal` 네임스페이스 분리
- [ ] **Phase 5**: `rclone` pCloud 연동 및 systemd 자동 마운트 (`--vfs-cache-max-size 30G`)
- [ ] **Phase 6**: Jellyfin 배포 (non-root, `hostPath` readOnly, SA 토큰 비활성화) 및 Direct Play 테스트
- [ ] **Phase 7**: 도메인 연결, cert-manager + Let's Encrypt HTTPS 적용, 로그인 보호(fail2ban/CrowdSec)
- [ ] **Phase 8**: `internal` 구역 더미 API/DB 및 `kube-prometheus-stack` (Prometheus + Grafana) 배포
- [ ] **Phase 9**: Choke Firewall (`NetworkPolicy` default-deny + 최소 허용 규칙) 적용
- [ ] **Phase 10**: DMZ Pod 내부에서 `nmap` 모의 침투 스캔 및 차단 결과 증빙 보고서 작성
