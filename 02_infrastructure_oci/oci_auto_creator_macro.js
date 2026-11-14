// ==============================================================================
// OCI Ampere A1 Out of Host Capacity 자동 요청 매크로
// ==============================================================================
// 목적: Oracle Cloud Always Free ARM (VM.Standard.A1.Flex) 자원 부족(500 에러) 시
//       30초 주기로 Create 버튼을 재요청하여 자원 반납 즉시 인스턴스 획득
// 사용법: OCI 인스턴스 생성 화면에서 F12 개발자 도구 Console에 복사/붙여넣기
// ==============================================================================

if (window.ociTimer) clearInterval(window.ociTimer);

(function () {
    let attempt = 1;
    const intervalSeconds = 30; // 요청 주기 (30초)

    console.log("%c[OCI Auto-Creator] 30초 주기 자동 생성 매크로 가동 시작!", "color: green; font-size: 16px; font-weight: bold;");

    function getCreateButton() {
        return document.querySelector('button[aria-label="Create"]') || 
               document.querySelector('button[aria-label="생성"]');
    }

    // 1회 즉시 실행
    const initialBtn = getCreateButton();
    if (initialBtn) {
        console.log(`%c[시도 #1] Create 클릭! (${new Date().toLocaleTimeString()})`, "color: #1e90ff; font-weight: bold;");
        initialBtn.click();
        attempt++;
    }

    // 30초 주기 반복 타이머
    window.ociTimer = setInterval(() => {
        // 인스턴스 상세 페이지로 리다이렉트되면 자동 성공 감지
        if (window.location.href.includes("/instances/ocid1.")) {
            console.log("%c🎉 인스턴스 생성 성공! 매크로를 즉시 종료합니다. 🎉", "color: red; font-size: 20px; font-weight: bold;");
            clearInterval(window.ociTimer);
            alert("인스턴스가 성공적으로 생성되었습니다!");
            return;
        }

        const btn = getCreateButton();
        if (btn) {
            console.log(`%c[시도 #${attempt}] Create 클릭! (${new Date().toLocaleTimeString()})`, "color: #1e90ff; font-weight: bold;");
            btn.click();
            attempt++;
        } else {
            console.warn("[대기] 버튼 로딩 중이거나 요청 처리 중...");
        }
    }, intervalSeconds * 1000);

    window.stopMacro = function () {
        clearInterval(window.ociTimer);
        console.log("%c사용자에 의해 매크로가 중단되었습니다.", "color: orange;");
    };
})();
