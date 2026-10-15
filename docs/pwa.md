# PWA
웹 콘솔을 홈 화면과 독립 창에서 실행하는 설치형 앱으로 제공하며, 접근 제어 대상인 위키 데이터는 오프라인 캐시에 저장하지 않는다.

## 배경

사용자는 브라우저 탭뿐 아니라 홈 화면 아이콘과 독립된 앱 창에서 LLM Wiki를 열 수 있어야 한다. 별도 네이티브 앱 대신 기존 웹 콘솔에 PWA의 설치 메타데이터와 서비스 워커를 더한다.

위키 내용은 [폴더별 접근 제어](access-control.md#읽기와-쓰기-범위) 대상이며 같은 기기를 여러 사람이 사용할 수 있다. 인증된 화면이나 API 응답을 오프라인 캐시에 보관하면 로그아웃·사용자 변경·권한 변경 뒤에도 이전 사용자의 지식이 남을 수 있다. 따라서 설치 경험과 오프라인 읽기를 분리하고, 서비스 워커에는 공개된 연결 안내 페이지만 저장한다. 오프라인 상태에서는 위키 탐색과 도니 질의응답을 사용할 수 없다.

## 내용

### 설치 메타데이터와 아이콘

`web/app/manifest.ts`가 Next.js App Router의 파일 규약에 따라 `/manifest.webmanifest`를 제공한다. 필드는 다음과 같다.

| 필드 | 값과 의미 |
| --- | --- |
| `id`, `start_url`, `scope` | 모두 `/`다. 앱 식별자와 시작 화면, 설치 앱의 경로 범위를 루트로 둔다. |
| `name`, `short_name` | 모두 `LLM Wiki`다. 설치 안내와 홈 화면에서 표시할 이름이다. |
| `description` | `팀의 위키를 탐색하고, 도니에게 질문한다.`다. |
| `lang` | `ko`다. |
| `display` | `standalone`이다. 설치한 앱은 브라우저 탭 대신 독립 창에서 연다. |
| `background_color`, `theme_color` | 모두 `#ffffff`다. 설치 앱의 초기 배경과 기본 테마 색상이다. |

아이콘 파일과 용도는 다음과 같다.

| 파일 위치 | 제공 경로와 용도 |
| --- | --- |
| `web/public/icons/icon-192.png` | `/icons/icon-192.png`다. 192×192 PNG이며 manifest의 `purpose: 'any'`로 일반 앱 아이콘에 사용한다. |
| `web/public/icons/icon-512.png` | `/icons/icon-512.png`다. 512×512 PNG이며 manifest의 `purpose: 'any'`로 큰 앱 아이콘에 사용한다. |
| `web/public/icons/icon-maskable-512.png` | `/icons/icon-maskable-512.png`다. 512×512 PNG이며 `purpose: 'maskable'`로 기기의 원형·둥근 사각형 마스크에 대응한다. 중요한 도형은 잘리지 않는 안전 영역에 둔다. |
| `web/app/apple-icon.png` | Next의 Apple 아이콘 파일 규약으로 연결한다. 180×180 불투명 PNG이며 Apple 홈 화면 아이콘으로 사용한다. |
| `web/app/icon.svg` | Next의 아이콘 파일 규약으로 연결한다. `#171717` 배경에 흰색 BookOpen 도형을 둔 브라우저 favicon이다. |

`web/app/layout.tsx`의 `applicationName`은 `LLM Wiki`다. Apple 메타데이터는 `appleWebApp.capable: true`, `title: 'LLM Wiki'`, `statusBarStyle: 'default'`로 설정한다. 페이지 viewport의 `themeColor`는 밝은 모드에서 `#ffffff`, 어두운 모드에서 `#171717`이며 manifest의 고정 테마 색상과 구분한다.

### 서비스 워커와 접근 경계

`web/public/sw.js`를 `/sw.js`로 제공하며 scope는 `/`다. 설치 시 `llmwiki-offline-v1` 캐시에 `/offline.html` 하나만 미리 저장하고 `skipWaiting()`을 호출한다. 위키 HTML, API 응답, 첨부 파일과 앱 자산을 서비스 워커 캐시에 저장하지 않는다. 이 정책은 서비스 워커의 Cache Storage 범위에 관한 결정이며 일반 HTTP 캐시까지 없앤다는 뜻은 아니다.

활성화 시 현재 `CACHE_NAME`을 제외한 `llmwiki-` 접두사의 캐시를 삭제한다. 다른 이름의 캐시는 삭제하지 않는다. 이어서 navigation preload를 명시적으로 끄고 `clients.claim()`으로 열린 화면을 제어한다. 이전 버전 워커가 켜 둔 preload 설정은 등록에 남아 있으므로, 활성화 단계에서 `disable()`을 호출해 기존 설치까지 끈다.

navigation preload를 쓰지 않는 이유는 백엔드 경로의 중복 요청 때문이다. preload가 켜져 있으면 브라우저는 워커의 `fetch` 핸들러와 별도로 모든 내비게이션 요청을 `Service-Worker-Navigation-Preload` 헤더와 함께 먼저 보낸다. 핸들러가 아래의 백엔드 경로처럼 `respondWith()`를 호출하지 않으면 브라우저는 preload 응답을 버리고 같은 요청을 네트워크로 한 번 더 보낸다([w3c/ServiceWorker#1611](https://github.com/w3c/ServiceWorker/issues/1611)). 일회용 상태를 소비하는 `/auth/google/callback`은 첫 preload 요청이 로그인 state를 소비하므로 화면에 표시되는 두 번째 요청이 `invalid_google_state`(`Google login state has expired or already been used`)로 실패했다. [인증](auth.md)의 Google 로그인과 MCP 인가처럼 한 번만 처리해야 하는 내비게이션이 있으므로 preload를 다시 켜지 않는다. 다시 켜야 한다면 백엔드 내비게이션도 preload 응답으로 `respondWith()`해야 한다.

서비스 워커는 같은 origin의 `GET` 내비게이션 요청만 가로챈다. API 조회 같은 비내비게이션 요청, 다른 origin의 요청, `POST` 등은 그대로 네트워크로 간다. 내비게이션도 다음 백엔드 경로와 하위 경로는 제외한다.

```text
/api, /auth, /oauth, /mcp, /skills, /.well-known, /healthz, /readyz, /metrics
```

제외 판정은 `^/(api|auth|oauth|mcp|skills|\.well-known|healthz|readyz|metrics)(/|$)` 정규식으로 수행한다. 경로 경계를 검사하므로 `/api`와 `/api/me`는 제외하지만 `/api-example`까지 제외하지 않는다. 이 정규식은 [Nest와 Next의 라우팅 경계](architecture.md#nestjs와-nextjs의-mvc-경계)를 정하는 `src/main.ts`의 정규식과 같아야 한다. 백엔드 경로를 추가하거나 변경하면 `src/main.ts`와 `web/public/sw.js`를 함께 고친다. 한쪽만 바꾸면 인증이나 백엔드 내비게이션에 웹 오프라인 안내가 대신 나타날 수 있다. 공개 Skill 다운로드도 오프라인 안내로 대체하거나 서비스 워커 캐시에 보관하지 않는다.

로그인은 Nest가 처리하는 `/auth` 경로로 이동한다. 서비스 워커는 로그인과 OAuth 내비게이션을 가로채거나 캐시하지 않으므로 오프라인 로그인을 제공하지 않는다. 웹의 로그인 화면과 설정 흐름은 [웹 문서](web.md#로그인과-관리-화면)에 기록한다.

처리 대상 내비게이션은 네트워크 `fetch`로 응답한다. 네트워크 요청 자체가 실패할 때만 캐시된 `/offline.html`을 반환하며 HTTP 404·500 응답을 오프라인 페이지로 바꾸지 않는다. 캐시에 안내 페이지도 없으면 네트워크 오류를 반환한다. `web/public/offline.html`은 외부 자산 없이 동작하는 한국어 안내 페이지이며, `다시 시도` 버튼과 브라우저의 `online` 이벤트가 현재 URL을 다시 불러온다.

### 등록과 업데이트

`web/components/service-worker.tsx`를 `web/app/providers.tsx`에 마운트한다. 서비스 워커를 지원하는 브라우저에서만 동작하며 `NODE_ENV=production`일 때 페이지의 `load` 이후 `/sw.js`를 등록한다. 이미 로드가 끝났으면 바로 등록한다. 등록 옵션은 `scope: '/'`, `updateViaCache: 'none'`이다.

개발 모드에서는 등록하지 않고, 기존 등록 중 워커 스크립트 경로가 `/sw.js`인 등록을 해제한다. Turbopack HMR로 화면을 갱신하는 개발 흐름과 서비스 워커의 제어를 분리하고, 프로덕션 확인 뒤 같은 origin에 남은 워커가 개발 화면을 가로채지 않게 하기 위한 정책이다. 등록 해제 전에 이미 제어되던 탭은 닫거나 다시 열어 워커 제어가 끝났는지도 확인한다.

`web/next.config.ts`는 `/sw.js`에 `Content-Type: application/javascript; charset=utf-8`과 `Cache-Control: no-cache, no-store, must-revalidate`를 설정한다. `updateViaCache: 'none'`과 함께 워커 업데이트 확인 시 HTTP 캐시가 예전 스크립트를 돌려주지 않게 하므로 새 스크립트를 즉시 확인할 수 있다. 서버 변경이 모든 열린 탭에 자동으로 푸시된다는 의미는 아니다. `/offline.html`에는 `Cache-Control: no-cache`를 설정하고 설치 시에도 `cache: 'reload'`로 가져온다.

`/offline.html`만 수정하면 워커 스크립트의 바이트는 바뀌지 않아 기존 워커가 다시 설치되지 않을 수 있다. 오프라인 페이지를 바꿀 때는 `sw.js`의 `CACHE_NAME` 버전도 함께 올린다. 예를 들어 `llmwiki-offline-v1`을 `llmwiki-offline-v2`로 바꾸면 새 설치에서 안내 페이지를 가져오고 활성화 시 이전 캐시를 삭제한다.

### 확인 방법

서비스 워커 등록은 프로덕션 빌드에서만 확인할 수 있다. 로컬에서 `pnpm build` 후 `NODE_ENV=production pnpm start`로 빌드된 Nest와 Next를 실행한다. 환경 변수와 인증 준비는 [개발 환경의 실행 절차](development.md#로컬-실행과-첫-관리자)를 따른다. 프로덕션 모드는 개발 로그인을 허용하지 않는다. 기존 서버와 병렬로 확인할 때는 [독립 복사본과 데이터·포트 격리 절차](development.md#개발-서버-출력과-병렬-실행)를 따른다.

1. HTTPS 또는 로컬 `localhost`의 보안 컨텍스트에서 페이지를 연 뒤 브라우저 개발자 도구의 Application 영역에서 manifest 이름·아이콘·scope와 `/sw.js` 등록을 확인한다. 설치를 지원하는 브라우저에서는 홈 화면 또는 앱 설치 후 독립 창으로 열리는지 확인한다.
2. 서비스 워커 활성화와 페이지 제어를 확인한 뒤 Cache Storage에 현재 `llmwiki-offline-*` 캐시의 `/offline.html`만 있는지 확인한다. 노트와 로그인 화면을 방문해도 위키·인증 응답이 여기에 추가되지 않아야 한다.
3. 오프라인 상태에서 새 웹 내비게이션을 수행하여 한국어 안내 페이지가 나타나는지 확인한다. `다시 시도`와 연결 복구 시 원래 URL을 다시 불러오는지도 확인한다.
4. `/auth` 등 백엔드 경로의 내비게이션에는 오프라인 안내가 대신 표시되지 않는지 확인한다. 같은 내비게이션이 서버에 한 번만 도달하고 `Service-Worker-Navigation-Preload` 헤더가 붙은 요청이 없는지도 확인한다. 네트워크 탭에서 `/sw.js`와 `/offline.html`의 응답 헤더도 확인한다.
5. 개발 모드로 돌아오면 `/sw.js` 등록이 해제되는지 확인하고, 기존 제어 탭을 닫은 뒤 새 탭에서 HMR이 정상 동작하는지 확인한다.

## 관련 문서

- [웹](web.md)은 위키 탐색·질의응답과 웹 콘솔의 화면 동작을 설명한다.
- [폴더별 접근 제어](access-control.md)는 오프라인 위키 캐시를 두지 않는 결정의 권한 경계를 설명한다.
- [개발 환경](development.md)은 빌드·로컬 실행과 병렬 서버의 격리·종료 절차를 설명한다.
- [아키텍처](architecture.md)는 하나의 Node 프로세스에서 Nest와 Next가 요청을 나누는 경계를 설명한다.
