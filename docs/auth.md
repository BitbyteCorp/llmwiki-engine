# 인증과 권한
엔진은 웹과 MCP 사용자를 관리자에게 발급받은 이메일·비밀번호 또는 Google Workspace 로그인으로 확인하고, MCP 접근에는 엔진 자체 OAuth 토큰을 발급한다.

## 배경

웹과 외부 MCP 클라이언트가 같은 지식 저장소에 접근하므로 사용자 확인과 엔진의 접근 권한을 연결해야 한다. Google을 이용하지 않는 환경에서도 관리자가 계정과 초기 비밀번호를 발급할 수 있으며, 두 로그인 방식 모두 엔진의 허용 도메인과 역할 정책을 따른다. 공개 회원가입, 가입·인증 메일, 비밀번호 재설정 메일은 제공하지 않는다.

## 내용

### Nest 모듈 구성

`AuthModule`은 사용자·세션·이메일·비밀번호·Google OIDC·OAuth 제공자와 인증 컨트롤러를 등록한다. `UsersRepository`와 `OAuthRepository`는 SQL 데이터 접근을 담당하며, `UsersService`는 사용자 검증·비밀번호 관리·로그인 정책·마지막 관리자 보호를 담당한다. `SessionsService`는 서명된 쿠키와 DB 세션을 관리하고, `GoogleOidcService`는 브라우저에 결합된 OIDC 요청과 Google 신원 검증을 담당한다. Google issuer는 `GOOGLE_ISSUER` 제공자 토큰으로 주입하므로 테스트에서는 로컬 issuer로 교체한다.

인증 모듈은 웹과 MCP 모듈에 사용자·세션 서비스와 가드를 내보낸다. Nest는 컨트롤러에 지정한 가드를 해당 컨트롤러 모듈의 DI 범위에서도 생성하므로, `McpAuthGuard`가 의존하는 `OAuthService`도 내보내 MCP 모듈에서 주입을 해결한다. 모듈 간 순환 의존은 두지 않는다.

`AuthController`는 `/auth/*`, `OAuthController`는 `/oauth/*`와 `/.well-known/*`를 제공한다. OAuth 서비스는 클라이언트 검증과 코드·토큰 수명 주기를 담당한다. 리디렉션과 OAuth 오류 응답은 Express 응답 객체를 통해 기존 상태·헤더·본문을 유지하며, 토큰과 폐기 요청은 URL-encoded 폼을 받는다. 웹 API는 `SessionGuard`로 현재 사용자를 확인하고 `RolesGuard`와 `@Roles()`로 최소 역할을 검사한다. 역할 메타데이터가 없으면 `viewer`가 최소 역할이다. `@CurrentUser()`는 가드가 설정한 요청 사용자를 컨트롤러에 전달한다.

CLI의 `user add|password|role|list`는 `auth.commands.ts`에 정의하며, 지연 생성한 Nest 애플리케이션 컨텍스트에서 `UsersService`를 조회한다. 인증 모듈은 HTTP 실행과 CLI 실행 모두에서 같은 제공자를 사용하며, 별도 Express 라우터나 서비스들을 묶어 전달하는 기존 `AppContext` 객체를 두지 않는다.

### 웹 로그인과 접근 제어

웹의 `/login`은 이메일·비밀번호 로그인과 설정된 Google OpenID Connect 로그인을 제공한다. Google 로그인은 허용 도메인을 ID 토큰의 `hd` 클레임과 이메일 도메인으로 함께 검사한다. 비밀번호 로그인은 기존 계정의 이메일 도메인만 검사하며 Google의 `hd`나 이메일 검증을 요구하지 않는다.

기본값은 허용 목록 사용(`allowlistEnabled=true`)과 빈 허용 도메인 목록(`allowedDomains=[]`)이다. 첫 관리자를 CLI로 비밀번호와 함께 등록한 뒤 웹 관리 화면에서 다음 설정을 변경한다. 빈 도메인 목록은 두 방식 모두 도메인 제한을 적용하지 않는다는 뜻이며, Google 로그인은 여전히 Google의 검증된 이메일을 요구한다.

- Google 로그인에서 허용 목록을 켜면 `users` 테이블에 등록된 이메일만 로그인할 수 있다. 끄면 도메인 검사를 통과한 신규 사용자를 `viewer`로 자동 등록하는 기존 동작을 유지한다.
- 비밀번호 로그인은 허용 목록 설정과 관계없이 이미 등록되어 있고 비밀번호가 설정된 계정만 사용한다. 신규 사용자를 자동 생성하지 않으며, 비밀번호 없는 Google 계정에 비밀번호를 임의로 발급하지 않는다.
- 허용 도메인 목록이 비어 있지 않으면 비밀번호 로그인은 이메일 도메인이 목록에 포함되어야 한다. Google 로그인은 이메일 도메인과 Google ID 토큰의 `hd`가 서로 같고 목록에 포함되어야 하며, `hd`가 없으면 거절한다. 도메인은 대소문자를 구분하지 않는다.
- 사용자별 역할은 `admin`, `editor`, `viewer`다. `viewer`는 읽기·검색·채팅을 수행하고, `editor`는 지식 쓰기를 추가로 수행하며, `admin`은 관리 설정까지 수행한다. 마지막 관리자는 삭제하거나 다른 역할로 내릴 수 없으며, 해당 요청은 409 응답을 받는다.

사용자 ID는 계정 삭제 뒤에도 재사용하지 않는다. 마이그레이션 `013_acl.sql`은 현재 최대 ID에서 시작하는 영속 `user_id_highwater`를 만들며 `UsersRepository.create`는 높은 값의 다음 ID를 단일 INSERT로 배정한다. 명시적인 ID를 가진 데이터 삽입도 높은 값을 갱신하고 삭제와 재시작은 이를 낮추지 않는다. 기존 users 테이블과 외래 키는 재구축하지 않는다.

이는 삭제된 계정의 ACL 주체·작업 요청자·열린 스트림이 다른 새 계정으로 해석되는 것을 방지한다. 사용자 삭제 시 사용자별 ACL 규칙도 감사 기록과 함께 제거하며 스트림은 계정의 이메일과 생성 시각으로 인증 당시 신원을 다시 확인한다.

웹 관리 화면의 접점은 [웹 버전](web.md#로그인과-관리-화면)에 설명한다.

### 로그인 API

| 경로 | 요청과 응답 |
| --- | --- |
| `GET /auth/providers` | 인증 없이 `{ google: boolean, password: true }`를 반환한다. `google`은 Google 클라이언트 설정 여부이며, 비밀번호 로그인은 항상 제공한다. |
| `POST /auth/password/login` | JSON `{ email, password, next?, request? }`를 받아 웹 세션을 만들고 `{ redirectTo: string }`을 반환한다. 일반 웹 로그인은 안전한 내부 `next`로 이동하며 기본값은 `/wiki`다. MCP 로그인은 검증된 `request`로 인가를 계속한다. |
| `GET /auth/google/login` | 일반 로그인은 내부 `next`를, MCP 로그인은 `request`를 전달한다. Google 인증 뒤 웹 세션을 만들고 같은 웹·MCP 목적지로 이동한다. |

비밀번호 로그인은 로그인 전 요청이더라도 `PUBLIC_URL`과 같은 출처의 `Origin`을 요구하며, `Origin`이 없는 경우에만 `Sec-Fetch-Site: same-origin`을 허용한다. `next`는 `/`로 시작하는 엔진 내부 경로만 허용하며 프로토콜 상대 경로·역슬래시·탭을 포함한 모든 제어 문자를 수용하지 않는다. MCP의 `request`가 있으면 클라이언트가 보낸 `next`가 아니라 저장된 인가 흐름을 사용한다.

알 수 없는 이메일, 비밀번호 없는 계정, 틀린 비밀번호는 모두 401 `invalid_credentials`로 응답한다. 비밀번호 없는 계정과 알 수 없는 계정도 더미 scrypt 검증을 수행하여 같은 검증 경로를 유지한다. 올바른 비밀번호라도 허용 도메인 밖이면 403 `login_denied`다. 잘못된 요청 본문은 400 `invalid_input`, 찾을 수 없거나 만료·소비·브라우저 불일치인 MCP 요청은 404 `login_request_not_found`다. 성공 시 `lastLoginAt`을 갱신한다.

### 비밀번호 정책과 저장

비밀번호는 Unicode 코드 포인트 기준으로 정규화 전과 NFKC 정규화 후 모두 8~128자여야 한다. 대문자·소문자·숫자·특수문자 조합을 강제하지 않으며, trim하지 않는다. 설정·변경·검증에 같은 NFKC 정규화를 적용한다. 정책에 맞지 않는 새 비밀번호는 400 `weak_password`다.

`src/auth/password.ts`는 Node의 scrypt로 비밀번호를 해시한다. 매 설정마다 16바이트 난수 salt를 만들고 `N=16384`, `r=16`, `p=1`, `keylen=64`, `maxmem=64 MiB`를 사용한다. `027_user_passwords.sql`은 `users.password_hash`와 기본값 0인 내부 `password_revision`을 추가하며 기존 사용자에는 비밀번호가 없다. DB 해시 저장 형식은 `scrypt$<salt hex>$<hash hex>`다.

비밀번호 원문과 해시는 사용자 DTO·API 응답·CLI 출력·로그·감사 기록에 포함하지 않는다. 사용자 객체에는 `hasPassword: boolean`만 공개한다. 비밀번호 제거는 Google 로그인이나 사용자 계정을 제거하지 않는다.

비밀번호 설정·제거마다 내부 `password_revision`을 단조 증가시킨다. 이미 비밀번호가 없는 계정을 다시 제거할 때도 증가시키며 같은 비밀번호 재설정도 별개의 변경으로 본다. 비동기 scrypt 처리 중 관리자나 CLI가 비밀번호를 교체할 수 있으므로, 자기 비밀번호 변경과 비밀번호 로그인은 처리 뒤 같은 revision인지 다시 확인한다. 비밀번호 변경과 웹 세션 폐기는 한 트랜잭션으로 커밋한다. 비밀번호 로그인 완료도 재검증 트랜잭션 안에서 웹 세션 생성, MCP 요청 소비와 엔진 인가 코드 발급을 함께 처리하여, 동시 비밀번호 복구 뒤 이전 자격 증명으로 새 세션이나 코드를 만들지 못하게 한다. 이 revision은 공개 사용자 객체에 포함하지 않는다.

### 자기 계정과 관리자 비밀번호 관리

| 경로 | 요청과 응답 | 권한과 세션 처리 |
| --- | --- | --- |
| `GET /api/me` | `{ user }`에 `hasPassword`를 포함한다. | 현재 사용자다. |
| `POST /api/me/password` | `{ currentPassword?, newPassword }`를 받아 204를 반환한다. | 쿠키 세션만 허용한다. 현재 요청의 검증된 세션은 유지하고 다른 웹 세션은 모두 폐기한다. |
| `POST /api/admin/users` | 기존 사용자 생성 입력에 선택적 `password`를 받는다. | 관리자가 계정과 초기 비밀번호를 함께 발급할 수 있다. |
| `PUT /api/admin/users/:id/password` | `{ password }`를 받아 204를 반환한다. | 관리자가 비밀번호를 설정·교체하고 대상의 웹 세션을 모두 폐기한다. |
| `DELETE /api/admin/users/:id/password` | 204를 반환한다. | 관리자가 비밀번호를 제거하고 대상의 웹 세션을 모두 폐기한다. |

자기 계정에 비밀번호가 없으면 `currentPassword` 없이 처음 설정할 수 있다. 이미 비밀번호가 있으면 올바른 현재 비밀번호를 요구하며 누락·불일치는 400 `invalid_current_password`다. 관리자의 설정·제거는 현재 비밀번호를 요구하지 않는다. 없는 사용자 ID는 404 `not_found`다.

모든 역할은 `/settings?tab=account`에서 비밀번호를 처음 설정하거나 변경한다. 관리자 사용자 화면은 생성 시 초기 비밀번호와 기존 사용자 비밀번호 설정·제거를 제공한다. 비밀번호를 잊었을 때는 관리자에게 교체를 요청하거나 운영자가 CLI로 복구하며 재설정 메일은 보내지 않는다.

CLI `user password`로 설정·제거할 때도 대상의 웹 세션을 모두 폐기한다. 이 폐기는 웹 세션에만 적용하며 이미 발급된 MCP OAuth 액세스·리프레시 토큰과 REST API 토큰은 폐기하지 않는다. 이 토큰은 각각 기존 토큰 폐기 경로로 관리한다.

### 폴더별 접근 제어

전역 역할에 [폴더별 접근 제어](access-control.md)를 함께 적용한다. 관리자는 경로 규칙을 우회하며 적용 가능한 규칙이 없으면 기존 역할 권한을 유지한다. 가장 긴 적용 접두사 안에서 사용자·역할·전체 순으로 규칙을 고른다. `write` 규칙도 전역 조회자를 편집자로 올리지 않는다.

전역 `AclModule`의 `AclService`를 웹·MCP·도니가 함께 사용한다. 읽을 수 없는 경로는 존재를 숨기는 `404 not_found`, 읽을 수 있지만 쓸 수 없는 경로는 `403 forbidden`이다. 관리자는 `/api/admin/acl`과 `/api/admin/acl/check`에서 규칙과 실효 권한을 관리하며 변경은 감사 기록에 남긴다.

### 첫 관리자 등록과 비상 복구

CLI는 첫 관리자 등록과 관리자 계정을 잃었을 때의 비상 복구에만 사용한다. 처음에는 웹에 로그인해 관리 설정을 바꿀 관리자가 없으므로, 웹 밖에서 첫 관리자를 만들어야 한다. 이후의 사용자·권한 관리는 웹 관리 화면에서 수행한다.

첫 관리자 등록과 비상 복구 명령은 다음과 같다.

```bash
pnpm cli user add a@example.com --role admin --name "관리자" --password
pnpm cli user password a@example.com
pnpm cli user password a@example.com --clear
pnpm cli user role a@example.com admin
pnpm cli user list
```

첫 명령은 표준 입력에서 비밀번호를 받아 Google 설정이나 개발 로그인 없이 `/login`에 접근할 첫 관리자를 만든다. `--password`는 값을 받지 않는 플래그이며 비밀번호를 명령행 인자로 전달하지 않는다. TTY에서는 입력을 숨기고 확인을 포함해 두 번 받으며 비TTY에서는 한 줄만 읽는다. `user password`도 같은 방식으로 읽고, `--clear`를 지정하면 입력 없이 비밀번호를 제거한다. 로컬·Docker 실행 예시는 [개발 환경](development.md)에 기록한다.

Google 로그인은 인가 코드, PKCE S256, 임의의 `state`와 `nonce`를 사용한다. 10분 유효한 로그인 요청은 브라우저 쿠키와 결합하며 한 번만 사용한다. 콜백은 JWKS 서명과 `iss`, `aud`, `exp`, `nonce`, `email_verified`를 검증한 뒤 접근 정책을 적용한다. Google 클라이언트 설정이 없으면 서버와 비밀번호 로그인은 사용할 수 있지만 Google 로그인은 제공하지 않는다.

웹 세션은 DB에 저장한 임의 식별자의 SHA-256 해시와 `SESSION_SECRET`으로 서명한 쿠키를 사용한다. `llmwiki_session` 쿠키는 `HttpOnly`, `SameSite=Lax`, 30일 유효 기간을 가지며 `PUBLIC_URL`이 HTTPS면 `Secure`를 추가한다. 로그아웃은 쿠키와 DB 세션을 함께 삭제한다. 개발 환경에서는 기존 사용자 이메일을 `DEV_LOGIN_EMAIL`에 지정해 `/auth/dev-login`으로 로그인할 수 있다. 운영 환경에서는 이 설정을 거부한다.

### MCP의 OAuth 인가 서버

엔진은 MCP 인가 사양에 맞는 OAuth 인가 서버 역할을 한다. MCP 클라이언트가 `/oauth/authorize`로 접근하면 엔진은 인가 요청을 검증하고 로그인 화면으로 이동시킨다. 사용자는 이메일·비밀번호 또는 설정된 Google 로그인을 선택하며, 엔진이 로그인 결과를 확인한 뒤 자체 액세스 토큰을 발급한다. Google 토큰이나 비밀번호를 MCP 클라이언트에 전달하지 않는다.

이 구분은 사용자 확인과 지식 저장소 접근 인가를 분리하기 위한 것이다. 클라이언트가 접근하려는 대상은 Google API가 아니라 엔진이므로, 엔진이 발급한 토큰으로 엔진의 도메인·역할 정책을 적용한다.

엔진이 지원하는 MCP 인가 구성 요소는 다음과 같다. 대상 클라이언트가 사용하는 발견·클라이언트 식별·인가 방식을 수용하기 위해 이 구성을 선택한다.

- Protected Resource Metadata는 `/.well-known/oauth-protected-resource`와 `/.well-known/oauth-protected-resource/mcp`에서 제공한다. 리소스 식별자는 `PUBLIC_URL`의 `/mcp`다.
- Authorization Server Metadata는 `/.well-known/oauth-authorization-server`에서 제공한다.
- `/oauth/authorize`는 등록된 `redirect_uri`, `response_type=code`, `code_challenge_method=S256`, PKCE challenge, `resource`를 검사한다. 성공한 로그인은 5분 유효한 일회용 엔진 인가 코드를 클라이언트에 반환한다. 검증된 리디렉션 주소에는 인가 오류도 `error`와 원래 `state`로 반환한다. 알 수 없는 클라이언트나 미등록 리디렉션 주소에는 이동하지 않고 400 오류를 반환한다.
- 리디렉션 주소는 정확히 일치해야 하지만, 루프백 HTTP 주소(`127.0.0.1`·`[::1]`·`localhost`)만 포트를 무시하고 비교한다(RFC 8252 §7.3). Codex 같은 네이티브 클라이언트는 CIMD 문서에 `http://127.0.0.1/callback/<id>`처럼 포트 없는 주소를 등록하고 요청마다 임의 포트(`http://127.0.0.1:55224/callback/<id>`)를 쓰기 때문이다. 호스트·경로·쿼리는 그대로 비교하므로 `127.0.0.1`로 등록한 주소에 `localhost`로 요청하면 거부한다. 토큰 교환의 `redirect_uri`는 인가 요청에 쓴 포트 포함 주소와 정확히 같아야 한다.
- `/oauth/register`는 DCR을 제공한다. 공개 클라이언트(`token_endpoint_auth_method=none`)만 지원하며 리디렉션은 HTTPS 또는 로컬 루프백 HTTP여야 한다.
- CIMD는 HTTPS URL 형태의 `client_id` 문서를 가져와 URL과 문서의 `client_id` 및 리디렉션 목록을 확인한다. 문서는 1시간 캐시하고, 64 KiB 크기와 5초 요청 제한을 적용하며 리디렉션 응답과 사설 네트워크 주소를 거부한다. 테스트 환경에서만 HTTP 문서를 허용한다.
- `/oauth/token`은 PKCE를 검증해 1시간 액세스 토큰과 30일 리프레시 토큰을 발급한다. 리프레시 때 새 토큰을 발급하고 이전 리프레시 토큰을 폐기한다. `/oauth/revoke`로 액세스 토큰을 폐기할 수 있으며, 리프레시 토큰을 폐기하면 같은 발급 계열의 액세스·리프레시 토큰도 폐기한다. DB에는 코드·토큰의 SHA-256 해시만 저장한다.
- MCP 미인증 요청은 401과 `WWW-Authenticate: Bearer …, resource_metadata="…/.well-known/oauth-protected-resource/mcp"`를 반환한다. 토큰 검증 후 현재 사용자 역할을 다시 조회하므로 역할 변경은 다음 요청부터 적용된다.

`McpAuthGuard` 안에서 MCP SDK의 `requireBearerAuth`를 사용해 Bearer 파싱, 만료·리소스 검사와 표준 오류 헤더를 재사용한다. Nest가 Express 어댑터를 사용하므로 요청·응답 객체를 그대로 전달할 수 있으며, SDK가 이미 오류 응답을 보낸 경우 가드는 컨트롤러 실행을 막고 전역 오류 필터는 전송된 응답을 덮어쓰지 않는다. 따라서 인증 파싱을 다시 구현하지 않고 기존 OAuth 오류 형식과 `WWW-Authenticate`를 유지한다. `mcpAuthRouter`와 `OAuthServerProvider`는 사용하지 않는다. 브라우저에 결합된 로그인 요청, 두 로그인 방식과 DB 트랜잭션 기반 코드·토큰 수명 주기를 같은 모듈에서 처리하는 쪽이 어댑터 중복을 줄이기 때문이다.

### MCP 로그인 흐름

`/oauth/authorize`는 클라이언트·리디렉션·PKCE·리소스를 검증한 다음 그 결과를 서버에 저장한다. 10분 유효한 일회용 요청은 브라우저 쿠키와 결합하며, 로그인 화면에는 불투명한 요청 식별자만 `/login?request=…`로 전달한다. 브라우저가 반환한 임의의 OAuth 필드를 인가 흐름으로 신뢰하지 않는다.

비밀번호 로그인은 `POST /auth/password/login`의 `request`로 저장된 흐름을 마치며, 비밀번호 검증과 로그인 정책을 통과한 경우에만 요청을 한 번 소비하고 5분 유효한 인가 코드를 발급한다. 비밀번호 검증 실패는 인가 요청을 소비하지 않으므로 유효 기간 안에서 다시 시도할 수 있다. Google 로그인은 `request`를 검증한 뒤 Google의 진행 중 로그인 흐름으로 넘길 때 원래 요청을 소비한다. 따라서 Google에서 로그인을 거절하거나 그 흐름이 실패하면 클라이언트가 `/oauth/authorize`부터 새로 시작해야 한다. 두 방식 모두 만료·이미 사용한 요청이나 다른 브라우저의 요청은 사용할 수 없다.

다음 흐름에서 사용자 신원을 확인하고 MCP 토큰을 발급하는 주체는 모두 엔진이다.

```mermaid
sequenceDiagram
    participant C as MCP 클라이언트
    participant E as 엔진
    participant U as 사용자
    participant G as Google
    C->>E: Protected Resource Metadata 조회
    C->>E: Authorization Server Metadata 조회
    C->>E: DCR 또는 CIMD로 클라이언트 식별
    C->>E: /oauth/authorize 요청과 PKCE
    E->>E: 인가 필드 검증·브라우저 결합 요청 저장
    E->>U: /login?request=…로 이동
    alt 이메일·비밀번호
        U->>E: /auth/password/login + request
        E->>E: 기존 계정·비밀번호·이메일 도메인 확인
    else Google
        U->>E: /auth/google/login?request=…
        E->>G: Google 로그인으로 이동
        U->>G: Workspace 로그인
        G->>E: 로그인 결과
        E->>E: 허용 도메인·허용 목록·역할 확인
    end
    E->>E: 웹 세션 생성·인가 코드 준비
    E->>C: 인가 코드 반환
    C->>E: 인가 코드와 PKCE 검증값으로 토큰 요청
    E->>C: 엔진 자체 액세스 토큰 발급
    C->>E: 엔진 토큰으로 MCP 접근
```

### REST API 토큰

REST 자동화는 `/api/tokens`에서 발급한 `lwk_` 접두사의 Bearer 토큰을 사용한다. 원문은 암호학적 난수이며 DB의 `api_tokens`에는 SHA-256 해시만 저장한다. 토큰은 발급 응답에서 한 번만 표시하며 목록에는 해시와 원문을 포함하지 않는다.

| 경로 | 요청과 응답 | 권한 |
| --- | --- | --- |
| `GET /api/tokens` | `{ tokens: ApiToken[] }`을 반환한다. `?all=1`은 모든 소유자의 토큰을 반환한다. | 자기 목록은 로그인 사용자, 전체 목록은 관리자다. |
| `POST /api/tokens` | `{ name, scopes: ['read' \| 'write'], expiresAt?: ISO시각 \| null }`을 받아 201과 토큰 메타데이터·일회용 `token`을 같은 객체로 반환한다. | 쿠키 세션만 허용한다. API 토큰으로 새 토큰을 발급할 수 없다. |
| `DELETE /api/tokens/:id` | 해당 토큰을 폐기하고 204를 반환한다. | 소유자 또는 관리자다. |

메타데이터는 `id`, `userId`, `name`, `scopes`, `createdAt`, `expiresAt`, `lastUsedAt`, `revokedAt`다. 만료를 지정하지 않으면 `expiresAt`은 `null`이다. 사용한 토큰은 `lastUsedAt`을 갱신한다. 현재 사용자 역할은 매 요청 다시 조회하며 토큰 발급 당시 역할을 고정하지 않는다.

읽기 요청(GET·HEAD)은 `read`, 변경 요청은 `write` 범위를 요구한다. 범위는 역할을 대체하지 않는다. `viewer`의 `write` 범위 토큰도 편집자 전용 경로에 접근할 수 없다. 유효하지 않거나 만료·폐기된 토큰은 401이며 부족한 범위는 403이다. Bearer 헤더가 있으면 쿠키로 인증을 재시도하지 않는다. MCP OAuth 토큰은 `/mcp` 리소스 전용이며 REST 인증으로 수용하지 않는다. `lwk_` 토큰도 MCP OAuth 인증을 대신하지 않는다.

### CSRF 경계

쿠키로 인증한 POST·PUT·PATCH·DELETE는 `PUBLIC_URL`의 origin과 같은 `Origin` 헤더를 요구한다. `Origin`이 없는 경우에만 `Sec-Fetch-Site: same-origin`을 허용한다. 교차 origin, `null` origin, 출처 헤더가 없는 변경 요청은 403 `csrf_rejected`를 반환한다. Origin은 scheme·host·port를 비교하며 경로를 포함하지 않는다.

이 검사는 관리 변경, 자기 비밀번호 변경, 채팅, 로그아웃에도 적용한다. 로그인 전의 `POST /auth/password/login`도 같은 `Origin`·`Sec-Fetch-Site` 검사 규칙을 적용한다. REST Bearer 인증은 브라우저 쿠키에 의존하지 않으므로 CSRF 검사를 면제하지만 Bearer의 유효성과 범위는 별도로 검사한다. 로그아웃과 자기 비밀번호 변경은 세션 전용 경로이므로 Bearer 헤더로 인증이나 CSRF 검사를 대신하지 않는다. `/oauth/*`는 OAuth·PKCE·state 검증 규칙을 유지하고 이 세션 CSRF 규칙을 적용하지 않는다.

### 요청 제한과 프록시

`@nestjs/throttler` 저장소는 인증 경로의 IP 예산과 인증된 사용자의 검색·채팅 메시지·쓰기·가져오기 예산을 분리한다. 기본 집계 구간은 `RATE_LIMIT_WINDOW_MS=60000`이며 IP당 인증 요청은 `RATE_LIMIT_AUTH=30`, 사용자별 공유 예산은 `RATE_LIMIT_USER=60`이다. 한도를 초과하면 429 `rate_limited`와 다음 요청까지 기다릴 초 단위 `Retry-After`를 반환한다.

IP 예산은 `/auth/password/login`, `/auth/google/login`, `/auth/google/callback`, `/auth/dev-login`, `/oauth/authorize`, `/oauth/register`, `/oauth/token`, `/oauth/revoke`가 공유한다. 사용자 예산은 검색 하위 경로, 채팅 메시지 작성·편집·재생성·재시도, 노트 변경·되돌리기·첨부 저장, 가져오기에 적용한다. MCP의 `search`, `similar_notes`, `write`, `ingest_source` 호출도 같은 사용자 예산을 사용하며 도구 목록·노트 읽기는 제외한다. 제한된 요청을 반복해도 대기 시간이 연장되지 않는다.

기본 `TRUST_PROXY=false`는 전달 IP 헤더를 신뢰하지 않는다. 역방향 프록시에서 `true`를 설정하면 Express의 전달 IP 해석을 사용한다. 이 경우 외부 클라이언트가 서버에 직접 접속하지 못하게 하고 프록시가 전달 헤더를 덮어써야 한다. 각 프로세스의 메모리 제한이므로 여러 인스턴스를 배포하면 인스턴스별로 예산이 적용된다.

### 만료 인증 정리

`AuthCleanupService`는 시작 시와 `AUTH_CLEANUP_INTERVAL_MS=300000`마다 만료 세션, 진행 중 로그인, 일회용 코드, 만료·폐기 토큰을 정리한다. 서버 종료 시 타이머를 해제하며 만료 시각 인덱스를 사용한다. OAuth에서 회전된 리프레시 토큰의 발급 계열에 유효 토큰이 남아 있으면 폐기 기록을 유지한다. 이전 리프레시 토큰으로도 전체 발급 계열을 폐기하는 기존 동작을 보존하기 위한 경계다.

### 감사 기록

전역 `AuditService.record({ actorId, action, target, outcome, summary? })`는 `audit_events`에 변경 행위와 결과를 추가한다. 사용자·역할·설정 변경, API 토큰 생성·폐기와 각 기능의 관리·파괴 작업을 기록한다. 토큰 원문이나 요청 본문은 기록하지 않는다. 삭제된 사용자도 기존 행위자의 숫자 ID를 유지하며 외래 키로 감사 이력을 삭제하지 않는다.

관리자 전용 `GET /api/admin/audit?before=&limit=&actor=&action=`은 `{ events, nextCursor }`를 반환한다. 행은 `{ id, actorId, action, target, outcome, summary, createdAt }`이며 최신 ID부터 정렬한다. `before`는 제외되는 행 ID 문자열, `limit`은 기본 50·최대 200, `actor`는 사용자 ID, `action`은 정확한 행위 문자열 필터다. `nextCursor`는 다음 페이지의 `before`에 전달하며 마지막 페이지는 `null`이다.

HTTP 사용자 관리의 행위 이름은 `user.create`, `user.update`, `user.role`, `user.delete`, `settings.update`이며 결과는 `success` 또는 `failure`다. 비밀번호 변경·관리자 설정·제거는 각각 `user.password.change`, `user.password.set`, `user.password.clear`를 기록한다. API 토큰은 `token.create`, `token.revoke`를 기록한다. CLI 사용자 추가·역할·비밀번호 관리는 같은 행위 이름과 `actorId: null`을 사용하고 실패 결과는 `error`다. 비밀번호를 포함한 CLI 사용자 생성은 `user.create`와 `user.password.set`을 함께 기록한다. 권한 가드·검증·서비스 단계에서 거절된 HTTP 관리 변경도 기록하며 한 요청을 중복 기록하지 않는다. 감사 기록에는 비밀번호 원문·해시를 넣지 않는다.

## 관련 문서

- [MCP](mcp.md)는 인증 후 제공하는 지식 도구와 리소스를 설명한다.
- [설치형 Skills](skills.md)는 대상 클라이언트별 연결과 로그인 설정 방법을 설명한다.
- [웹](web.md)은 브라우저에서 제공하는 기능을 설명한다.
