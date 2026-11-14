# Oracle Cloud k3s 애니 미디어 서버 로드맵 (B안)

VM 1대에 k3s 단일 노드를 올리고 **네임스페이스(`dmz` / `internal`)**로 구역을 분리하여, pCloud 애니메이션 스트리밍과 이중 방화벽(Screening + Choke) 실습을 함께 진행하는 최종 계획입니다.

---

## 1. 목표

| 우선순위 | 목표 |
| :---: | :--- |
| 1 | pCloud에 있는 애니메이션을 어디서든 Jellyfin으로 스트리밍 시청 |
| 2 | 이중 방화벽(Screening + Choke) 개념을 Kubernetes로 구현하고 `nmap`으로 검증 |
| 3 | Prometheus + Grafana로 리소스 및 캐시 모니터링 (외부 노출 차단) |
| 4 | **Oracle Always Free 한도 내**에서 추가 요금 0원으로 운영 |

---

## 2. 전체 구조

```mermaid
flowchart LR
    User["외부 사용자<br/>폰 · TV · PC"] -->|"80/443"| SL["OCI Security List<br/>Screening Firewall"]
    Admin["나 (관리자)"] -->|"22, 내 IP만"| SL
    SL --> ING

    subgraph A1["VM1 k3s-main · A1.Flex 2 OCPU / 12GB / 100GB"]
        subgraph DMZ["namespace: dmz"]
            ING["Traefik Ingress"] --> JF["Jellyfin"]
        end
        NP["NetworkPolicy<br/>Choke Firewall"]
        subgraph INT["namespace: internal"]
            API["Jellystat API<br/>(시청 통계 수집)"]
            DB["PostgreSQL DB<br/>(시청 기록 원본)"]
            MON["Prometheus + Grafana"]
            API -->|"5432"| DB
        end
        RC["rclone mount (호스트)<br/>/mnt/pcloud read-only"]
        JF -->|"hostPath"| RC
        JF -.->|"허용 포트만"| NP --> API
        JF -.->|"❌ 차단"| DB
        JF -.->|"❌ 차단"| MON
    end

    RC -->|"필요할 때만 스트리밍"| PC["pCloud<br/>애니 폴더"]
    subgraph MICRO["VM2 monitor · AMD Micro 1GB (선택)"]
        UK["Uptime Kuma"]
    end
    UK -->|"주기적 상태 확인"| SL
    UK -->|"다운 시 알림"| Noti["Discord / Telegram"]
```

### 이중 방화벽 매핑

| 실습 랩 개념 | 이 프로젝트에서 |
| :--- | :--- |
| InternetRouter | Oracle 인터넷 게이트웨이 |
| **Screening Firewall** | **OCI Security List** (+ VM 안의 `iptables`) |
| Screened Subnet (DMZ) | `dmz` 네임스페이스 (`Traefik`, `Jellyfin`) |
| **Choke Firewall** | **NetworkPolicy** (`default-deny`) |
| 내부망 (LAN) | `internal` 네임스페이스 (`Jellystat API`, `PostgreSQL DB`, `Grafana`) |

---

## 3. 자원 계획 및 메모리 예산

### Always Free 한도 대비

| 자원 | 한도 | 사용 계획 | 남음 |
| :--- | :--- | :--- | :--- |
| A1 OCPU / 메모리 | 2 OCPU / 12 GB | `k3s-main` 2 OCPU / 12 GB | 0 |
| AMD Micro | 2대 | (선택) `monitor` 1대 | 1~2대 |
| 블록 스토리지 | 200 GB | `k3s-main` 100 GB (+ 선택 Micro 50 GB) | 50~100 GB |
| 아웃바운드 트래픽 | 월 10 TB | 애니 시청 수준이면 여유 | 9 TB 이상 |

### VM1 메모리 예산 (12 GB 기준)

| 구성요소 | 예상 메모리 | 제한(limit) 설정 |
| :--- | :--- | :--- |
| OS + k3s + Traefik | 약 1.2 GB | - |
| Jellyfin | 1 ~ 3 GB | `4Gi` |
| rclone (호스트) | 약 0.5 GB | 캐시 상한 `30G` 디스크 제한 |
| Prometheus + Grafana | 약 1.5 ~ 2 GB | Prometheus `1Gi`, Grafana `256Mi` |
| Jellystat (API) + PostgreSQL (DB) | 약 0.3 ~ 0.8 GB | 각 `512Mi` |
| **합계** | **약 5 ~ 8 GB / 12 GB** | 여유 4 GB 이상 |

---

## 4. 진행 단계 체크리스트

### Phase 0: 준비 (완료)
- [x] Oracle Cloud 가입 (홈 리전: US West San Jose)
- [x] Shape `VM.Standard.A1.Flex`, 이미지 `Ubuntu 24.04 Minimal aarch64` 선택

### Phase 1: VM1 생성 및 스케일업 (완료)
- [x] `Out of host capacity` 극복 (브라우저 자동 생성 매크로 + 1 OCPU 선확보)
- [x] VCN(`k3s-vcn`) / 퍼블릭 서브넷(`k3s-subnet`) 및 Public IPv4(`147.224.xx.xx`) 할당
- [x] SSH 키 저장 및 PowerShell에서 SSH 접속 확인
- [x] 2 OCPU / 12 GB RAM / 100 GB 부트 볼륨 구성 완료

### Phase 2: OS 기본 설정 (완료)
- [x] `sudo apt update && sudo apt install -y curl wget vim nano htop iotop net-tools`
- [x] `sudo apt upgrade -y` 및 시간대 확인 (`Etc/UTC`, 별도 변경 없이 유지)
- [x] OCI Ubuntu 이미지의 `iptables`에서 80/443 및 K3s CIDR(`10.42.0.0/16`, `10.43.0.0/16`) 허용, `FORWARD` 기본 차단 해제 및 `netfilter-persistent save`
- [x] 자동 보안 업데이트(`unattended-upgrades` active) 및 SSH 비밀번호 로그인 비활성화(`PasswordAuthentication no`, `KbdInteractiveAuthentication no`) 확인

> **왜 `iptables`를 열어야 하나요?** 일반 클라우드 우분투와 달리 OCI 우분투 이미지는 출고 시점부터 OS 내부 `iptables`(현관문)가 `22(SSH)` 외 모든 트래픽을 `REJECT`로 막고 있어, OCI 콘솔(정문)과 별개로 웹 표준 포트(`80`, `443`)와 K3s CIDR(`10.42.0.0/16`, `10.43.0.0/16`)을 `REJECT` 규칙보다 위쪽 번호에 열어주어야 정상 통신됩니다.

### Phase 3: Screening Firewall (OCI Security List — 완료)
| 포트 | 출발지 | 용도 |
| :--- | :--- | :--- |
| 22/TCP | **내 집 IP/32** (권장) | SSH |
| 80/TCP | `0.0.0.0/0` | Let's Encrypt 인증 및 HTTPS 리다이렉트 |
| 443/TCP | `0.0.0.0/0` | Jellyfin (HTTPS) |
| 그 외 | 차단 | `6443`(kube API)은 SSH 터널로만 접근 |

- [x] Security List 수신(`Ingress`) 규칙에 `80/TCP`, `443/TCP` 추가 완료 (`ICMP Type 8 ping` 차단 유지)
- [x] 외부 포트 도달 검증 (`iptables -L INPUT -v` 패킷 증가 + `6443` 차단 + K3s 설치 전 `Test-NetConnection` 기준선 확보, K3s 설치 후 최종 `True`/`nmap` 재검증 예정)

### Phase 4: k3s 설치 (완료)
- [x] k3s 단일 노드 설치 (`v1.37.2+k3s1`, `systemd` 서비스 등록 및 노드 `Ready` 확인)
- [x] `Traefik` 인그레스 컨트롤러 구동 및 외부 포트(`80`, `443`) 리스닝 검증 (`TcpTestSucceeded : True`)
- [x] 네임스페이스 `dmz`, `internal` 선언적 YAML 배포 및 보안 티어 라벨(`zone=dmz`, `zone=internal`) 적용 확인
- [ ] `kubeconfig` 내 PC 복사 및 SSH 터널(`-L 6443:localhost:6443`) 연동 (선택)
- [ ] Helm 설치

### Phase 5: pCloud 연동 (호스트 — 완료)
- [x] `rclone` ARM64 설치 후 `rclone config`로 pCloud 연결 (헤드리스 OAuth2 토큰 발급)
- [x] `systemd` 서비스(`rclone-pcloud.service`)로 `/mnt/pcloud` 자동 마운트 (`Anime/일 반  애 니` 전용 격리, `--read-only --vfs-cache-mode full --vfs-cache-max-size 25G --vfs-cache-max-age 24h --allow-other`)
- [x] `df -h` 명령어로 총 11TB 규모 파일시스템 정상 마운트 검증 완료 (87% 사용, 9.5TB 사용 / 1.6TB 가용)

### Phase 6: Jellyfin 배포 (`dmz`)
- [ ] Deployment 작성 (`hostPath` readOnly + `mountPropagation: HostToContainer`, non-root, `allowPrivilegeEscalation: false`, `automountServiceAccountToken: false`)
- [ ] 라이브러리 설정: 실시간 폴더 감시, 챕터 이미지, Trickplay 비활성화
- [ ] 클라이언트(Jellyfin Media Player, Findroid 등)에서 Direct Play 확인 (ASS 자막 포함)

### Phase 7: 외부 공개
- [ ] 도메인 연결 (DuckDNS 등 무료 DDNS 또는 개인 도메인)
- [ ] `cert-manager` + Let's Encrypt로 HTTPS 적용 및 Traefik Ingress 설정
- [ ] 외부 망(LTE)에서 접속 테스트 및 CrowdSec/fail2ban 적용

### Phase 8: 내부 서비스 및 모니터링 (`internal`)
- [ ] `Jellystat` (API) + `PostgreSQL` (DB) Pod 배포 (시청 통계 연동 및 Choke 방화벽 격리 검증 대상)
- [ ] `kube-prometheus-stack` 배포 (보존 기간 7일, 메모리 limit 설정)
- [ ] Grafana는 `kubectl port-forward`로만 접근

### Phase 9: Choke Firewall (`NetworkPolicy`)
- [ ] `dmz`, `internal`에 `default-deny` (Ingress 및 Egress) 적용
- [ ] 공통 허용: CoreDNS 53 포트
- [ ] `dmz`: Traefik → Jellyfin 8096 허용, Jellyfin → 인터넷(메타데이터, `169.254.169.254` 및 클러스터 내부 대역 제외), Jellyfin → `internal` API 특정 포트만 허용
- [ ] `internal`: Prometheus scrape 허용, 그 외 외부 및 DMZ 유입 차단

### Phase 10: 침투 검증
Jellyfin Pod가 탈취되었다고 가정하고 `dmz` 네임스페이스 디버그 Pod 내부에서 `nmap` 스캔 실행:

| 대상 | 기대 결과 |
| :--- | :--- |
| API 허용 포트 | ✅ 열림 |
| DB | ❌ 차단 |
| Grafana / Prometheus | ❌ 차단 |
| `169.254.169.254` (OCI 메타데이터) | ❌ 차단 |
| kube API (`6443` / `kubernetes.default`) | ❌ 토큰 부재로 거부 |

- [ ] 검증 결과 및 스크린샷을 포트폴리오에 기록

### Phase 11 (선택): 외부 감시용 VM2
- [ ] AMD Micro 인스턴스 생성 (부트 볼륨 50 GB)
- [ ] Docker로 Uptime Kuma 설치 및 다운 시 Discord/Telegram 알림 연결
