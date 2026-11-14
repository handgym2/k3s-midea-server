# 포트폴리오 상세 작업 기록집: Cloud Media Server & Zero-Trust Defense Network

> **프로젝트 요약**: Oracle Cloud Always Free ARM(Ampere A1) 인스턴스 위에 구축한 k3s(쿠버네티스) 기반 미디어 스트리밍 서버 및 이중 방화벽(Screening + Choke) 보안 검증 기록집입니다.  
> ※ 전체 요약 및 목차는 [README.md](./README.md)에서 확인할 수 있습니다.

---

## 0. 아키텍처 개요 (이중 방화벽 구조)

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

        NP["Kubernetes NetworkPolicy<br/>[Choke Firewall · 2차 방어]"]

        subgraph INT["namespace: internal (내부 격리망)"]
            API["Jellystat API Pod<br/>(시청 통계 수집)"]
            DB["PostgreSQL DB Pod<br/>(시청 기록 원본 DB)"]
            MON["Prometheus + Grafana"]
            API -->|"5432/TCP"| DB
        end

        JF -.->|"허용 포트만 통과"| NP --> API
        JF -.->|"❌ 차단"| DB
        JF -.->|"❌ 차단"| MON
    end

    RC -->|"필요 시 블록 스트리밍"| PC["pCloud<br/>(애니 · 자막 원본)"]
```

---

## 1. 인프라 프로비저닝 및 트러블슈팅 (OCI Always Free ARM)

### 1.1 문제 상황: 인기 리전 ARM 용량 부족 (`Out of host capacity`)
* **환경**: Oracle Cloud Infrastructure (OCI), US West (`us-sanjose-1`) 홈 리전
* **발생 오류**: `VM.Standard.A1.Flex` 인스턴스 생성 시 `500-InternalError, Out of host capacity` 에러가 반복 발생해 생성이 거부됨.

### 1.2 해결 과정: 자동 요청 매크로 제작 + 선확보 후 스케일업
1. **브라우저 DOM 자동화 스크립트 구현**: 오라클 콘솔의 생성 버튼(`button[aria-label="Create"]`)을 타겟팅하여 30초 간격으로 생성 요청을 재시도하는 [`oci_auto_creator_macro.js`](./02_infrastructure_oci/oci_auto_creator_macro.js) 작성.
2. **단계적 리소스 확보 전략**: 2 OCPU 연속 유휴 슬롯 대신 **1 OCPU / 6GB** 단위로 먼저 인스턴스를 확보한 뒤, PAYG 계정 업그레이드 및 리소스 조정을 통해 **2 OCPU / 12GB RAM**으로 안전하게 스케일업 완료.
3. **종료 안전장치**: 인스턴스 생성 성공 시 상세 페이지 URL(`/instances/ocid1.`) 전환을 감지해 타이머를 자동 종료.

#### 증빙 1: 자동 생성 매크로 실행 및 API 요청 로그
![자동 생성 매크로 실행 로그](./02_infrastructure_oci/screenshots/01_macro_automation.png)

---

### 1.3 공인 IP 동적 바인딩 및 2 OCPU / 12GB 스케일업 검증

* **인스턴스명**: `k3s-main`
* **OS**: Canonical Ubuntu 24.04 Minimal `aarch64`
* **사양**: Ampere A1 (`2 OCPU / 12 GB RAM / 2 Gbps` 네트워크 대역폭)
* **스토리지**: 부트 볼륨 `100 GB` (총 200 GB 무료 한도 내)
* **네트워크**: VCN `k3s-vcn` / Subnet `k3s-subnet` / Private IP `10.0.0.5` / Public IP `147.224.xx.xx` (Ephemeral)

#### 증빙 2: Primary VNIC 공인 IP(Public IP) 동적 할당
![공인 IP 할당 완료](./02_infrastructure_oci/screenshots/02_public_ip_assigned.png)

#### 증빙 3: 2 OCPU / 12GB RAM 스케일업 및 `Running` 상태 검증
![2 OCPU / 12GB 스케일업 검증](./02_infrastructure_oci/screenshots/03_instance_scaleup_verified.jpg)

---

## 2. 서버 베이스라인 환경 구성 및 필수 도구 설치

* **OS 선정 이유**: 불필요한 백그라운드 데몬과 패키지를 제거해 공격 표면(Attack Surface)을 줄이고 가용 메모리를 극대화하기 위해 **Ubuntu 24.04 Minimal (`aarch64`)** 선택.
* **초기 설치 유틸리티 7종**:

```bash
sudo apt update && sudo apt install -y curl wget vim nano htop iotop net-tools
```

| 패키지 | 용도 및 선정 이유 |
| :--- | :--- |
| `curl`, `wget` | `k3s`, `rclone` 등 설치 스크립트 다운로드 및 API 응답 확인 |
| `vim`, `nano` | Kubernetes YAML 매니페스트 및 `systemd` 서비스 파일 편집 |
| `htop` | ARM64 CPU 코어별 부하 및 메모리 점유율 실시간 모니터링 |
| `iotop` | `rclone` VFS 캐시 쓰기/읽기 시 디스크 I/O 병목 분석 |
| `net-tools` | `netstat`, `ifconfig`, `route` 등 네트워크 포트 리스닝 상태 진단 |

### 2.2 OCI Ubuntu 내부 방화벽(`iptables`) 설정 이유 및 적용 내역

* **배경 (정문 vs 현관문)**: 일반 클라우드(AWS 등)의 우분투는 현관문(`iptables`)이 기본적으로 열려 있어 클라우드 콘솔(정문)만 열면 되지만, **오라클 클라우드(OCI) 우분투 이미지는 출고 시점부터 현관문(`iptables`)이 `22번(SSH)`만 남기고 전부 강제 잠금(`REJECT --reject-with icmp-host-prohibited`)** 상태로 제공됩니다.
* **적용 내역 (`/etc/iptables/rules.v4`, 원본 `/etc/iptables/rules.v4.bak` 백업 후 `netfilter-persistent save`)**:
  1. **`80`, `443` 포트 허용 (`INPUT` 5·6번)**: Jellyfin 웹/앱 접속(HTTPS `443`) 및 인증서 발급·리다이렉트(HTTP `80`)를 위해 추가. `iptables`는 상단 번호부터 순서대로 평가하므로 마지막 `9번 REJECT`보다 **위쪽 번호**에 배치해 통과시키고, 나머지 미허용 포트는 기존처럼 `REJECT`로 방어.
  2. **K3s Pod/Service 대역 허용 (`INPUT` 7·8번 — `10.42.0.0/16`, `10.43.0.0/16`)**: 파드(Jellyfin, Traefik, CoreDNS)와 쿠버네티스 내부 서비스가 호스트와 통신할 때 `REJECT`에 의해 외부 침입으로 오인·차단되는 것을 방지.
  3. **`FORWARD` 체인 기본 `REJECT` 제거**: 파드 간 및 외부(`pCloud`) 트래픽 전달 통로의 기본 차단을 해제해 K3s CNI와 이후 2차 방화벽(`NetworkPolicy`)이 정상 동작하도록 조치.
* **검증 명령어**:
  ```bash
  sudo iptables -L INPUT -n -v --line-numbers
  sudo iptables -L FORWARD -n -v --line-numbers
  sudo diff -u /etc/iptables/rules.v4.bak /etc/iptables/rules.v4
  ```

![Ubuntu iptables rules.v4 설정 확인](./05_security_firewall/screenshots/01_iptables_rules_v4.png)

### 2.3 Screening Firewall (OCI Security List) 구성 및 K3s 설치 전 포트 검증

* **Ingress Rules 개방 (`80/TCP`, `443/TCP`)**:
  * 클라이언트(폰·PC)가 먼저 접속을 시작하는 구조이므로 Stateful 방화벽인 OCI Security List의 **`Ingress Rules`**에 `0.0.0.0/0` → Destination `80`, `443`을 추가 (`Source Port Range`는 임의 포트 허용을 위해 빈칸/`All`).
  * 기본 `ICMP` 규칙은 Type `3, 4`만 허용되어 `ping` (Type `8`) 응답은 차단 상태 유지.
* **K3s 설치 전 방화벽 통과 검증**:
  * 외부 `curl` 테스트로 VM 내 `iptables -L INPUT -n -v`의 80·443 `pkts` 카운터 증가(`0 → 5`, `0 → 3`)를 확인해 OCI Security List 통과를 검증했고, 아직 리스닝 데몬(Traefik)이 없어 `Test-NetConnection` 기준선(`TcpTestSucceeded : False`)을 기록해 두었습니다.

![OCI Ingress 80/443 규칙 입력](./05_security_firewall/screenshots/02_oci_ingress_port_setup.png)

![OCI Ingress Rules 반영 완료](./05_security_firewall/screenshots/03_oci_ingress_rules_table.png)

![K3s 설치 전 80/443 포트 응답 대기 상태 확인](./03_kubernetes_k3s/screenshots/01_before_k3s_port_test.png)

### 2.4 K3s 단일 노드 클러스터 구축 및 포트 활성화 검증

* **공식 스크립트 기반 설치**:
  ```bash
  curl -sfL https://get.k3s.io | sh -
  sudo chmod 644 /etc/rancher/k3s/k3s.yaml
  ```
* **서비스 가동 및 노드 준비 확인**:
  * `systemctl status k3s` 명령으로 `k3s.service`가 `active (running)` 상태임을 확인.
  * `kubectl get nodes -o wide` 실행 결과, `k3s-main` 노드가 `Ready` 상태(`v1.37.2+k3s1`)로 정상 등록됨.
  * `kubectl get pods -A` 실행 결과, `CoreDNS`, `metrics-server`, `local-path-provisioner` 및 웹 트래픽 라우팅을 담당하는 `svclb-traefik (2/2)`, `traefik (1/1)`이 정상 `Running` 상태로 올라옴.

![k3s 공식 설치 가이드](./03_kubernetes_k3s/screenshots/02_k3s_official_install_guide.png)

![k3s 서비스 가동 확인](./03_kubernetes_k3s/screenshots/03_k3s_service_running.png)

![k3s 노드 및 시스템 파드 구동 완료](./03_kubernetes_k3s/screenshots/04_k3s_nodes_pods_ready.png)

* **외부 포트 활성화 Before / After 비교**:
  * K3s 설치 전 `Test-NetConnection` 결과가 리스너 부재로 `False`였던 상태에서, `Traefik` 구동 후 `80`번(HTTP) 및 `443`번(HTTPS) 모두 `TcpTestSucceeded : True`로 전환됨을 확인.

![K3s 설치 후 80/443 포트 활성화 검증](./03_kubernetes_k3s/screenshots/05_after_k3s_port_test.png)

### 2.5 선언적 매니페스트 기반 네임스페이스(`dmz`, `internal`) 격리 및 라벨 검증

* **IaC 선언적 배포**:
  * 단순 CLI가 아닌 `01_namespaces.yaml` 매니페스트를 작성하여 `zone=dmz`, `zone=internal` 및 `security-tier` 보안 라벨을 선언.
  * 서버의 `~/manifests/` 디렉토리에서 `sudo kubectl apply -f namespaces.yaml`로 배포 완료.
  * `sudo kubectl get namespaces --show-labels` 실행 결과, `dmz` 및 `internal` 네임스페이스가 지정된 보안 라벨과 함께 `Active` 상태로 정상 생성됨을 확인.

| ① nano 선언적 네임스페이스 YAML 작성 | ② `kubectl apply` 배포 완료 |
| :---: | :---: |
| ![namespaces.yaml 작성](./03_kubernetes_k3s/screenshots/06_setup_namespaces.png) | ![네임스페이스 배포](./03_kubernetes_k3s/screenshots/07_namespaces_created.png) |

![보안 티어 라벨 적용 검증 완료](./03_kubernetes_k3s/screenshots/08_namespaces_labels_verified.png)

### 2.6 대용량 클라우드 스토리지(pCloud 11TB) Rclone VFS 마운트 및 고성능 스트리밍 캐시 구축

* **스토리지 최소 권한(Least Privilege) & 무결성 보장**:
  * pCloud 최상위 전체가 아닌 미디어 전용 하위 디렉터리(`Anime/일 반  애 니`)만을 타겟팅하여 개인 문서/백업 데이터로의 접근 경로를 원천 격리.
  * 파일시스템 레벨에서 `--read-only` 옵션을 적용하여 컨테이너 파드 또는 악의적인 침입자에 의한 원본 클라우드 데이터 손상/삭제 가능성을 원천 차단.
* **고성능 VFS 스트리밍 캐시 최적화**:
  * `--vfs-cache-mode full`: 대용량 동영상(1080p FHD/4K)의 실시간 탐색(Seek/Range Request)을 로컬 블록 장치 수준으로 캐싱하여 버퍼링 제로화.
  * `--vfs-cache-max-size 25G`: 100GB 부트 볼륨의 안정성을 지키면서 약 25~50화 분량의 영상을 SSD 속도로 서빙.
  * `--vfs-read-ahead 128M`, `--buffer-size 64M`: 스트리밍 시작 시 초기 지연 시간(TTFB) 단축.
* **보안 자격 증명 보호 및 시스템 데몬화**:
  * `chmod 600 /etc/rclone/rclone.conf`: OAuth2 토큰이 저장된 설정 파일을 root 전용 권한으로 봉인.
  * `rclone-pcloud.service` systemd 데몬 등록을 통해 24x365 무중단 자동 마운트 및 실패 시 자동 복구 보장.
  * `df -h` 명령어로 총 11TB 규모의 클라우드 저장소가 로컬 `/mnt/pcloud` 경로에 87% 사용량(9.5TB 사용 / 1.6TB 가용)으로 정상 마운트됨을 검증 완료.

| ① Rclone v1.76.0 ARM64 설치 | ② 헤드리스 OAuth2 토큰 발급 |
| :---: | :---: |
| ![rclone 설치](./04_storage_rclone/screenshots/01_rclone_installed.png) | ![원격 토큰 발급](./04_storage_rclone/screenshots/02_rclone_config_remote_token.png) |

| ③ pCloud 타겟 폴더 디렉터리 조회 (`lsd`) | ④ systemd 서비스 활성화 (`active running`) |
| :---: | :---: |
| ![pCloud 디렉터리 확인](./04_storage_rclone/screenshots/04_rclone_pcloud_lsd_verified.png) | ![rclone 서비스 활성화](./04_storage_rclone/screenshots/05_rclone_service_active.png) |

![11TB pCloud 파일시스템 마운트 용량 확인](./04_storage_rclone/screenshots/06_df_h_pcloud_mounted.png)

---

## 3. 향후 기록 예정 항목
* **Jellyfin 미디어 서버 배포**: DMZ 네임스페이스 내 파드 배포, `/mnt/pcloud` 볼륨 마운트 및 Traefik 인그레스 연동
* **Choke Firewall & 침투 테스트**: `NetworkPolicy` 적용 후 DMZ Pod 내부에서 `nmap` 스캔을 통한 DB/모니터링 차단 증빙
