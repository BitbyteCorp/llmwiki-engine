# 개발 환경과 실행
단일 루트 패키지의 NestJS 서버와 Next.js 웹, 모듈별 책임, 환경 변수, 로컬 실행과 Docker 이미지 구성을 설명한다.

## 배경
엔진은 별도 지식 저장소를 관리하는 단일 Node 프로세스다. 개발 문서인 이 저장소의 `docs/`와 엔진이 생성하는 지식 저장소는 구분한다. 런타임의 경계와 SQLite 선택 이유는 [엔진 아키텍처](architecture.md)에 기록한다. 이 문서의 명령은 로컬 개발과 이미지 검증용이며 상용 배포를 수행하지 않는다.

## 내용
### 스택과 패키지 경계
- Node.js 24, TypeScript 6, ESM, pnpm 10.34.6을 사용한다. 서버 TypeScript는 엄격 모드와 `NodeNext` 모듈 해석을 사용하며, 소스의 로컬 import에는 빌드 결과에 맞는 `.js` 확장자를 쓴다.
- 서버는 NestJS와 Express 어댑터를 사용한다. 개발과 CLI 실행은 SWC의 `@swc-node/register/esm-register`, 서버 컴파일은 `tsc`, 테스트는 Vitest와 `unplugin-swc`를 사용한다.
- 상태와 검색 인덱스는 `better-sqlite3`와 `sqlite-vec`로 SQLite에 저장한다. ORM 없이 SQL 마이그레이션을 적용한다.
- 도니는 OpenAI SDK의 Responses API와 함수 도구를 사용하며, [제공자 선택](agent.md#제공자-선택)으로 OpenAI 호환 API에 연결한다. 환경 변수 검증은 Zod, CLI는 Commander, 로그는 Pino, 스케줄은 Croner, JWT/JWKS는 Jose, frontmatter는 gray-matter를 사용한다. Git은 `git` CLI를 인자 배열로 실행한다.
- `web/`는 Next.js App Router, React 19, TypeScript, Tailwind CSS 4, shadcn/ui를 사용하는 웹 프로젝트다. 화면 경로는 App Router, 서버 상태는 TanStack Query, 마크다운은 react-markdown과 remark-gfm이 담당한다. 세부 화면 구성은 [웹](web.md)에 기록한다.
- 패키지는 루트 `package.json`과 `pnpm-lock.yaml` 하나로 관리하며 설치도 루트에서 한 번만 실행한다. Next.js와 UI 의존성도 루트에 두며 `web/package.json`이나 별도 웹 lockfile은 두지 않는다.

Nest의 클래스 타입 기반 DI는 데코레이터 메타데이터에 의존한다. 서버 컴파일 설정에는 `experimentalDecorators`와 `emitDecoratorMetadata`가 필요하며 런타임에는 `reflect-metadata`를 로드한다. esbuild와 이를 사용하는 `tsx`는 이 메타데이터를 생성하지 않으므로 서버 실행 도구로 사용하지 않는다. 개발·CLI의 SWC 로더와 Vitest의 `unplugin-swc`도 메타데이터를 생성하도록 설정하며, 배포용 서버는 TypeScript 6의 `tsc`로 컴파일한다. 웹의 TypeScript 설정은 `web/tsconfig.json`으로 분리한다.
TypeScript는 데코레이터 메타데이터를 생성하는 6.0.3으로 고정한다. `web/next.config.ts`를 운영 모드에서도 읽어야 하므로 TypeScript를 운영 의존성에 남긴다. SWC 네이티브 모듈은 pnpm 빌드 허용 목록의 `@swc/core`로 설치하며 서버 빌드는 테스트 파일을 제외하는 `tsconfig.build.json`을 사용한다.
Next의 CommonJS 진입점은 호출 가능한 함수를 내보내지만 `NodeNext` 타입 해석에서는 기본 내보내기를 모듈로 해석한다. HTTP 진입점은 이 외부 패키지만 `createRequire(import.meta.url)`로 로드하며, 서버 자체의 ESM 형식과 로컬 `.js` import 규칙은 유지한다.

### 레이아웃과 책임
| 경로 | 책임 |
| --- | --- |
| `src/config.ts`, `src/log.ts` | 환경 변수 검증과 로그를 담당한다. |
| `src/db/index.ts`, `src/db/migrations/` | SQLite 연결과 파일명 순서의 SQL 마이그레이션을 담당한다. 적용 이력은 `schema_migrations`에 기록한다. |
| `src/common/`, `src/app.module.ts` | 전역 설정·로그·DB 제공자, 오류 필터·검증 파이프·상태 확인과 기능 모듈 구성을 담당한다. |
| `src/main.ts`, `src/cli.ts` | Nest와 Next를 함께 실행하는 HTTP 진입점과 Nest 애플리케이션 컨텍스트를 사용하는 관리 명령 진입점이다. |
| `src/knowledge/`, `src/jobs/` | 지식 저장소의 git 조작과 쓰기 작업의 실행·상태·머지를 담당한다. |
| `src/agent/`, `src/knowledge/seed/` | 에이전트 루프와 도구, 빈 지식 저장소의 초기 문서를 담당한다. |
| `src/rag/` | 파생 검색 인덱스와 검색·재구축 명령을 담당한다. |
| `src/auth/` | 사용자·권한·설정, 이메일·비밀번호와 Google 로그인, 웹 세션, MCP OAuth를 담당한다. |
| `src/mcp/`, `src/api/` | MCP 도구와 웹 REST API·대화 저장을 각각 담당한다. |
| `src/dreaming/` | 정기 정리와 수동 실행 명령을 담당한다. |
| `src/ingest/`, `src/export/`, `src/backup/`, `src/skill/` | 원문 수집, main 내보내기, 오프라인 백업·복원, 버전 관리 Skill 설치를 담당한다. |
| `web/app/`, `web/components/`, `web/lib/` | App Router 화면, UI 컴포넌트, 웹 공용 코드를 담당한다. Next 빌드 결과는 `web/.next/`에 둔다. |
| `web/next.config.ts`, `web/tsconfig.json`, `web/postcss.config.mjs`, `web/components.json` | Next·웹 TypeScript·CSS·shadcn 설정을 담당하며 패키지 의존성은 루트에서 관리한다. |
| `web/public/` | Next가 제공할 공개 자산을 담는다. |
| `skills/` | 외부 클라이언트용 설치형 Skill을 담는다. |
| `test/fake-openai.ts` | 네트워크 없이 테스트할 OpenAI 호환 로컬 서버를 제공한다. |
| `scripts/` | 컴파일된 서버에 SQL 마이그레이션과 seed 자산을 복사한다. |

기능별 Nest 모듈은 컨트롤러·서비스·저장소 제공자를 등록하고 필요한 제공자를 명시적으로 내보낸다. 전역 `CommonModule`은 설정·Pino 로그·마이그레이션을 적용한 SQLite 연결을 `CONFIG`, `LOGGER`, `DB` 토큰으로 제공한다. 비클래스 의존성은 토큰으로 주입하며 서비스 클래스는 타입으로 주입한다. SQL 마이그레이션은 파일명 숫자 순서로 적용하며 원문 수집 이력은 `012_ingest`에 기록한다. 벡터 테이블은 임베딩 차원 설정에 맞춰 RAG 모듈이 런타임에 생성한다.

HTTP 진입점은 Nest 애플리케이션을 만들고 Next를 준비한 뒤 `JOBS_AUTOSTART=true`일 때 초기 검색 인덱스 동기화·인덱스 폴링·쓰기 워커·꿈꾸기 스케줄러를 시작한다. 가져오기 상태와 재시도 연결을 복구하는 비용 없는 재조정은 별도 Nest 시작 훅에서 수행한다. 자동 실행을 끈 서버와 수동 실행의 경계는 [운영](operations.md#자동-실행-중지)에 기록한다. CLI는 필요할 때 Nest 애플리케이션 컨텍스트를 만들고 모듈별 관리 명령에서 서비스를 조회하며 HTTP 서버·쓰기 워커·꿈꾸기 스케줄러를 시작하지 않는다. Nest 종료 훅은 `SIGINT`와 `SIGTERM`에서 서비스와 서버를 정리하고 DB 연결을 닫도록 한다. 요청 분기와 MVC 경계는 [엔진 아키텍처](architecture.md#nestjs와-nextjs의-mvc-경계)에 기록한다.
종료 전에는 초기 인덱스 동기화가 끝나기를 기다린다. Nest의 역방향 모듈 종료 순서에서 전역 `CommonModule`이 마지막에 DB를 닫으므로, 기능 서비스의 종료 훅은 작업 중단을 끝까지 기다려야 한다. `AppModule.beforeApplicationShutdown`은 Nest가 HTTP 서버를 닫기 전에 Next 핸들러를 닫고 추적한 업그레이드 소켓을 정리한다. Next 16의 custom server `close()`는 개발 락을 해제하지만 HMR WebSocket을 닫지 않으며, Node HTTP 서버의 `close()`는 열린 업그레이드 소켓이 있으면 완료되지 않는다. 따라서 Next를 HTTP 서버 종료 이후 훅에서 닫으면 HMR이 연결된 개발 서버의 `SIGINT`·`SIGTERM` 종료가 멈춘다. 업그레이드 소켓만 명시적으로 종료하며 일반 HTTP 요청의 정상 종료 대기는 Nest에 남긴다. CLI 애플리케이션 컨텍스트에는 HTTP 어댑터가 없으므로 소켓 추적을 생략한다.

공용 `ZodValidationPipe`는 검증과 Zod 변환 결과를 컨트롤러에 전달한다. 전역 `HttpExceptionFilter`는 HTTP 예외·Zod 검증 오류·도메인의 `status`와 `code` 오류를 `{ error: { code, message } }`로 반환한다. 예상하지 못한 오류는 500과 `internal_error`로 처리하고 내부 메시지를 노출하지 않는다. `/healthz`는 `{ ok: true }`를 반환한다.
Zod 검증 실패는 400과 `invalid_input`을 반환한다. 메시지는 각 오류를 점으로 연결한 `path: message`로 표현하고 여러 오류를 `; `로 연결하며, 경로 없는 오류는 기존 API 계약과 같은 `input: message`를 사용한다. 오류 객체의 숫자 `status`가 400~599이면 해당 상태를 보존하고, 문자열 `code`가 없는 500 이외 오류는 `bad_request`를 사용한다.

HTTP 진입점과 Nest 테스트 앱은 `src/common/http/configure-app.ts`의 `configureApp(app)`을 초기화와 수신 시작 전에 적용한다. OAuth 본문은 URL-encoded와 JSON 모두 64 KiB로 제한하며, URL-encoded 필드는 `extended: false`로 파싱한다. `/api/imports`와 `/mcp`의 JSON 본문은 원문 수집을 위해 21 MiB까지 받는다. 이후 공용 JSON·`extended: true` URL-encoded 파서를 명시적으로 등록해 나머지 백엔드 경로에는 기본 100 KiB 제한을 유지한다. Nest의 파서 중복 검사는 경로가 아니라 미들웨어 이름만 확인하므로 경로 전용 파서만 등록하면 다른 경로의 본문 파싱이 사라지는 함정이 있다. 본문 제한을 넘으면 413과 `bad_request`를 반환한다.

### SQL 마이그레이션과 테이블 재구축
`src/db/index.ts`의 마이그레이션 러너는 SQL 파일을 파일명 순서로 적용하고, 파일명과 적용 시각을 `schema_migrations`에 저장한다. 이미 적용한 파일은 다시 실행하지 않으며 각 파일의 SQL과 적용 이력 기록을 같은 트랜잭션으로 처리한다. 기존 마이그레이션은 변경하지 않고 새 파일로 스키마를 바꾼다.

적용 여부는 번호가 아니라 파일명 전체로 판정한다. 따라서 따로 개발한 브랜치를 합칠 때 같은 번호를 쓴 마이그레이션이 생기면 뒤에 합쳐지는 쪽을 기존 최대 번호 다음으로 다시 매긴다. 예를 들어 비밀번호 로그인의 `022_user_passwords.sql`은 main의 `022`~`025`와 겹쳐 `027_user_passwords.sql`이 되었다. 이름을 바꾸기 전 파일명으로 이미 적용한 DB는 새 이름을 미적용으로 보고 다시 실행하므로, 그런 DB에서는 `ALTER TABLE ... ADD COLUMN`이 중복 열 오류로 실패한다. 이런 DB는 `schema_migrations`의 이전 파일명을 새 파일명으로 고친 뒤 시작한다.

SQLite는 기존 `CHECK` 제약을 `ALTER TABLE`로 변경할 수 없으므로 테이블을 재구축해야 한다. 재구축 SQL은 `-- rebuild-table: <table>` 마커로 대상 테이블을 선언한다. 러너는 대상의 명시적 인덱스·트리거 정의와 기존 외래 키 설정을 보존하고, 트랜잭션 밖에서 `PRAGMA foreign_keys = OFF`를 적용한다. SQLite에서 트랜잭션 안의 `PRAGMA foreign_keys` 변경은 효력이 없기 때문이다. 이미 진행 중인 트랜잭션에서는 이 마커가 있는 마이그레이션을 거절한다.

삭제한 열을 참조하는 인덱스처럼 더 이상 유효하지 않은 객체는 `-- drop-schema: <name>` 마커로 이름을 명시한다. 러너는 재구축 대상의 보존 목록에서 해당 이름만 제외하며 다른 인덱스·트리거는 그대로 복원한다. 여러 객체를 제외하려면 마커를 객체마다 한 줄씩 선언한다. 이 마커는 SQL의 `DROP` 명령을 대신하지 않고 재구축으로 제거된 객체를 다시 생성하지 않도록 한다.

테이블 교체와 보존한 인덱스·트리거 복원 후 같은 트랜잭션에서 `foreign_key_check`를 실행한다. 위반이 있으면 스키마 변경과 적용 이력을 모두 롤백하며, 성공·실패와 관계없이 이전 외래 키 설정을 복원한다. [작업 종류 마이그레이션](write-flow.md#작업-종류와-출처)의 `016_agent_job_kind.sql`도 이 마커를 사용한다.

엔진 UUID의 저장 표현과 외부 표현을 바꾸는 데이터 마이그레이션은 [식별자](identifiers.md#기존-데이터-마이그레이션)의 SQL 함수·외래 키 지연·JSON 소유권 규칙을 따른다.

`019_agent_checkpoints.sql`은 에이전트 재개 상태를 저장하는 `agent_checkpoints` 테이블을 추가한다. 실행 경계와 호출자의 저장 책임은 [도니](agent.md)에 기록한다.

`020_import_jobs.sql`은 원문 수집 하나에 여러 통합 작업을 연결하는 `import_jobs` 테이블을 추가한다. `(import_id, batch)`를 기본 키로 쓰고 `job_id` 조회 인덱스를 둔다. 기존 `imports.job_id`의 값이 있는 행만 배치 0과 `files = '[]'`로 옮기며 식별자의 SQLite 저장 표현은 그대로 유지한다. 이전 기록에는 작업별 파일 목록이 없으므로 빈 배열은 파일 목록을 복원할 수 없다는 뜻이다. `imports`는 나머지 열·제약·행을 보존한 채 `job_id` 없이 재구축하며, `-- drop-schema: imports_job`으로 없어진 열의 인덱스만 복원에서 제외한다. 수집 이력을 삭제하면 연결된 배치 행도 외래 키의 `ON DELETE CASCADE`로 삭제한다. `job_id`에는 작업 테이블 외래 키를 두지 않으므로 작업이 삭제되어도 수집 이력의 작업 식별자는 유지한다.

### 루트 스크립트와 빌드 자산
| 명령 | 동작 |
| --- | --- |
| `pnpm dev` | `node --import @swc-node/register/esm-register src/main.ts`로 Nest와 Next 개발 모드를 한 프로세스에서 실행한다. |
| `pnpm build` | `next build web` 후 `tsc`로 서버를 컴파일하고 `scripts/build-assets.mjs`로 서버 자산을 복사한다. |
| `pnpm start` | `node dist/main.js`로 서버를 실행하며 `NODE_ENV=production`에서 빌드된 Next 앱을 제공한다. |
| `pnpm cli <명령>` | `node --import @swc-node/register/esm-register src/cli.ts`로 로컬 관리 명령을 실행한다. |
| `pnpm typecheck` | 서버와 `web/tsconfig.json`의 웹 타입을 모두 검사한다. |
| `pnpm test` | 데코레이터 메타데이터를 생성하는 SWC 변환을 적용해 Vitest를 실행한다. |

빌드 결과에는 `dist/main.js`, `dist/cli.js`, `dist/db/migrations/*.sql`, `dist/knowledge/seed/`와 `web/.next/`가 들어간다. SQL과 seed는 TypeScript 컴파일만으로 생성되지 않으므로 자산 복사 단계를 생략하지 않는다. 실행 시에는 루트 운영 의존성, Next 설정, `web/public/`, Skill 설치 명령의 원본인 루트 `skills/`도 필요하다. 웹은 항상 함께 빌드하며 Next standalone 출력이나 별도 웹 서버를 사용하지 않는다.

### 사용자 관리 CLI
| 명령 | 동작 |
| --- | --- |
| `pnpm cli user add <email> --role <admin\|editor\|viewer> [--name <name>] [--password]` | 사용자를 등록한다. `--password`를 지정하면 표준 입력에서 초기 비밀번호를 읽으며, 생략하면 비밀번호 없는 계정을 만든다. |
| `pnpm cli user password <email> [--clear]` | 기존 사용자의 비밀번호를 설정·교체한다. `--clear`는 비밀번호를 제거하며 입력을 받지 않는다. |
| `pnpm cli user role <email> <role>` | 마지막 관리자 보호를 적용해 역할을 변경한다. |
| `pnpm cli user list` | 등록된 사용자 목록을 JSON으로 출력한다. 비밀번호 원문·해시는 포함하지 않고 `hasPassword`로 설정 여부만 표시한다. |

`--password`는 값을 받지 않는 플래그다. 비밀번호를 명령행 인자나 환경 변수로 전달하지 않는다. TTY에서는 입력을 숨기고 비밀번호와 확인값을 두 번 받으며, 비TTY에서는 표준 입력 한 줄을 읽는다. 자동화에서는 비밀값을 안전한 표준 입력으로 전달한다. 비밀번호 정책·세션 폐기·감사 기록은 [인증](auth.md#비밀번호-정책과-저장)을 따른다.

### 내보내기·백업·Skill CLI
`pnpm cli export --out wiki.zip [--prefix wiki/] [--format zip|bundle]`은 현재 main을 내보낸다. ZIP은 선택한 경로와 HEAD manifest를 포함한다. bundle은 저장소 복원용 git 이력이며 prefix와 함께 사용할 수 없다.

`pnpm cli backup create --out backup.zip`, `pnpm cli backup verify backup.zip`, `pnpm cli backup restore backup.zip [--force]`는 SQLite와 지식 git 저장소를 묶어 보관·검증·복원한다. 복원은 HTTP 서비스를 시작하지 않는 오프라인 명령이며 먼저 서버를 중지한다. 데이터 경로와 스키마 호환성, 체크섬 규칙은 [백업과 복원](backup.md)을 따른다.

`pnpm cli skill install codex [--project /path/to/project]`, `pnpm cli skill update codex`, `pnpm cli skill status codex`는 설치 상태와 버전을 관리한다. 대상은 `claude-code`, `codex`, `hermes`다. 로컬 수정 파일은 `--force` 없이 덮어쓰지 않으며 MCP 연결과 OAuth는 별도로 수행한다. 설치 위치와 클라이언트별 절차는 [설치형 Skills](skills.md)를 따른다.

### 지식 구조 점검 CLI
`pnpm cli lint`는 현재 `main`의 지식 구조를 읽기 전용으로 보고한다. 기본 출력은 사람이 읽는 보고서이며 `pnpm cli lint --json`은 JSON으로 출력한다. 노트·schema·허브를 수정하거나 이동하지 않고, 워크트리·커밋을 만들거나 꿈꾸기를 실행하지 않는다.

보고서에는 중복 후보·고아 노트·과밀 폴더·모호하거나 미해결인 링크·노트 크기·태그 허브 부재와 도메인 허브 부재·루트 연결 누락·미분류 노트 신호가 포함된다. 신호의 후보 범위와 임계값은 [꿈꾸기의 구조 신호](dreaming.md#모드와-구조-신호)를 따른다. lint는 정리나 검증 통과 판정이 아닌 보고용 명령이므로 발견 사항이 있어도 종료 코드는 0이며, 명령 실행 오류만 0이 아닌 종료 코드를 반환한다.

경로·도메인·위키링크·크기 신호는 보고서의 `headSha`에 고정한 main을 사용한다. 중복·고아·태그 허브 신호는 기존 SQLite catalog를 읽으며, `indexedSha`가 main과 다르면 `catalog: "stale"`로 표시한다. DB나 색인 체크포인트가 없으면 이 세 신호는 깨끗하다는 빈 목록이 아니라 `catalog: "unavailable"`과 JSON의 `null`로 보고한다. lint는 저장소 초기화·seed 적용·DB 마이그레이션·재인덱싱·임베딩 생성을 수행하지 않는다.

메타데이터 점검은 같은 `headSha`의 노트 원문을 사용하며 catalog의 유무나 신선도에 의존하지 않는다. JSON의 `signals.invalidMetadata`에는 경로와 필드별 문제 목록을, `signals.invalidMetadataCount`에는 전체 문제 노트 수를 담는다. 목록의 상한·후보 범위와 꿈꾸기 선택 기준은 [꿈꾸기의 구조 신호](dreaming.md#모드와-구조-신호), 필수 속성과 기존 노트의 복구 원칙은 [노트 메타데이터 표준](note-metadata.md)을 따른다.

### OpenAI 로컬 테스트 fixture
`test/fake-openai.ts`의 `startFakeOpenAI(script?: readonly FakeTurn[])`는 `Promise<{ url, close, requests }>`를 반환한다. 서버는 루프백 주소의 임시 포트를 사용하며 `url`에는 이미 `/v1`이 포함된다. OpenAI SDK의 `baseURL` 또는 엔진의 `OPENAI_BASE_URL`에 그대로 전달하고 테스트 종료 시 `await close()`로 정리한다.

`script`는 `/v1/responses` 요청마다 한 턴씩 소비하는 큐다. 턴은 문자열, `{ text }`, `{ functionCalls, text? }`, `{ output }` 형식을 지원한다. `functionCalls`의 각 호출은 `name`, JSON 문자열이나 객체인 `arguments`, 선택적인 `call_id`를 가지며 `output` 배열은 텍스트와 함수 호출을 함께 담을 수 있다. 일반 응답과 SSE 스트리밍 응답을 모두 제공한다. 큐가 소진되면 임의의 답을 생성하지 않고 HTTP 400과 `fake_script_exhausted` 오류를 반환한다.

`requests`는 메서드·경로·요청 본문을 순서대로 기록하므로 에이전트가 도구 결과를 다음 요청에 넘겼는지 확인할 수 있다. `/v1/embeddings`는 SHA-256으로 시드한 결정론적 정규화 벡터를 반환하고 응답 큐를 소비하지 않는다. 요청의 `dimensions`를 사용하며 기본값은 1536이다. float 배열과 base64 인코딩을 지원한다.

fixture의 범위를 검증하는 명령은 `pnpm vitest run test/fake-openai.test.ts`다. 이 fixture는 OpenAI API의 유료 호출이나 외부 네트워크 없이 도구 호출과 스트리밍을 재현하기 위한 것이며 실제 모델 품질을 평가하지 않는다.

### 환경 변수
설정은 프로세스 환경 변수에서 읽는다. 키와 비밀값은 저장소나 이미지에 넣지 않고 실행 시 전달한다. 대부분은 `src/config.ts`의 Zod 스키마가 검증한다. 모델 목록과 기본 모델·추론 강도도 공용 설정을 사용하며, `UPLOAD_RETENTION_DAYS`는 업로드 서비스가 직접 읽는다. `LLM_MODELS`는 미설정일 때, `EMBEDDING_MODEL`은 미설정이나 빈 문자열일 때 제공자별 기본값을 사용하며 명시한 값이 우선한다. `LLM_MODELS`는 앞뒤 공백과 빈 항목을 제거한 뒤 하나 이상의 모델이 있어야 하므로 빈 문자열이나 공백·쉼표만 있는 목록은 시작 시 거절한다.

| 변수 | 기본값 | 의미 |
| --- | --- | --- |
| `NODE_ENV` | `development` | Docker 이미지는 `production`으로 설정한다. Next 개발 모드 선택, 개발 로그인 허용 여부와 세션 설정에 영향을 준다. |
| `PORT` | `3000` | HTTP 수신 포트다. |
| `PUBLIC_URL` | `http://localhost:3000` | 외부 기준 URL이며 OAuth issuer와 리디렉션에 사용한다. |
| `DATA_DIR` | `./data` | 영속 데이터 루트다. Docker에서는 `/data`다. |
| `JOBS_AUTOSTART` | `true` | `true` 또는 `false`만 허용한다. 자동 작업 실행과 초기·주기 색인 동기화를 제어하며 수동 요청의 경계는 [운영](operations.md#자동-실행-중지)을 따른다. |
| `SESSION_SECRET` | 상용 모드에서 필수 | 세션 쿠키 서명 비밀값이다. 개발·테스트에서 생략하면 시작마다 무작위로 생성하므로 재시작 후 기존 세션이 무효화된다. |
| `TRUST_PROXY` | `false` | `true`일 때만 역방향 프록시의 전달 IP를 신뢰한다. 직접 접속을 차단하고 신뢰할 프록시만 서버에 연결하는 배포에서 설정한다. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 인증 IP와 사용자별 요청 제한의 집계 구간(밀리초)이다. |
| `RATE_LIMIT_AUTH` | `30` | 인증·OAuth 경로에서 집계 구간당 IP별 최대 요청 수다. |
| `RATE_LIMIT_USER` | `60` | 검색·채팅 메시지·쓰기·가져오기가 공유하는 사용자별 최대 요청 수다. |
| `AUTH_CLEANUP_INTERVAL_MS` | `300000` | 만료 세션·인증 요청·코드·토큰 정리 주기(밀리초)다. |
| `LLM_PROVIDER` | `openai` | LLM·임베딩 제공자를 `openai` 또는 `openrouter`로 고른다. 다른 값은 Zod 검증으로 시작 시 거절한다. 제공자별 호출 경계는 [제공자 선택](agent.md#제공자-선택)을 따른다. |
| `OPENAI_API_KEY` | 미설정 | 선택한 제공자의 API 키다. 시작 시 필수는 아니지만 도니와 임베딩 실행에는 필요하다. 미설정이면 해당 기능이 명확한 오류로 실패한다. |
| `OPENAI_BASE_URL` | `openai`: 미설정 / `openrouter`: `https://openrouter.ai/api/v1` | OpenAI 호환 API 주소를 재정의하며 명시한 주소가 제공자별 기본값보다 우선한다. 테스트 서버 연결에도 사용한다. |
| `OPENAI_MAX_RETRIES` | `8` | 도니와 임베딩의 최초 요청 이후 최대 재시도 횟수다. 0 이상의 정수만 허용하며 `0`이면 재시도를 끈다. 429 대기 힌트와 선택적 검색 호출의 예외는 [OpenAI 재시도 정책](agent.md#openai-재시도-정책)을 따른다. |
| `LLM_MODELS` | `openai`: `gpt-6-luna` / `openrouter`: `openai/gpt-6-luna` | 쉼표로 구분하는 선택 가능 모델 목록이다. 앞뒤 공백과 빈 항목을 제거하고, 첫 항목을 기본 모델로 사용한다. 요청별 모델은 이 목록에 있어야 하며 목록은 비어 있을 수 없다. |
| `LLM_REASONING_EFFORT` | `medium` | 대화 답변과 노트 제안의 기본 추론 강도다. 도니의 추론 강도 허용 값은 `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`다. 웹 요청별 선택은 [모델과 호출 방식](agent.md#모델과-호출-방식)을 따른다. |
| `LLM_BACKGROUND_REASONING_EFFORT` | `low` | 대화 요약·부모 쓰기·서브에이전트·충돌 해결·꿈꾸기의 기본 추론 강도다. 위와 같은 허용 값으로 시작 시 검증하며 잘못된 값은 거절한다. 용도별 적용과 요청 옵션 우선순위는 [비용과 사용량](agent.md#비용과-사용량)을 따른다. |
| `LLM_COMPACT_THRESHOLD` | `50000` | OpenAI에서 도니의 입력 문맥 압축을 시작하는 토큰 임계값이며 `openrouter`에서는 효과가 없다. 양의 정수만 허용하며, 반복 입력 비용을 줄이기 위해 기본값을 120000에서 낮췄다. 압축·도구 페이지 상한은 [문맥 크기와 도구 페이지](agent.md#문맥-크기와-도구-페이지)를 따른다. |
| `UPLOAD_RETENTION_DAYS` | `7` | 사용하지 않는 임시 업로드의 보관 일수다. 가져온 raw 원문이나 assets git 파일의 보관 기간과 다르다. |
| `EMBEDDING_MODEL` | `openai`: `text-embedding-3-small` / `openrouter`: `openai/text-embedding-3-small` | 검색 임베딩 모델이다. |
| `EMBEDDING_DIMENSIONS` | `1536` | 임베딩 벡터 차원이다. |
| `SEARCH_RERANK` | `off` | `llm`이면 설정한 LLM 모델로 검색 후보를 재정렬한다. |
| `SEARCH_EXPAND` | `off` | `llm`이면 검색 질의 확장을 사용한다. |
| `INDEX_POLL_SECONDS` | `60` | 외부 git 변경과 지식 저장소 HEAD를 확인하는 인덱스 동기화 주기다. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | 미설정 | Google 로그인에만 필요하다. 미설정 상태에서도 부팅과 이메일·비밀번호 로그인이 가능하며 Google 로그인은 제공하지 않는다. |
| `KNOWLEDGE_REPO_URL` | 미설정 | 지식 저장소의 git 원격 주소다. 없으면 로컬 `main` 저장소를 생성하고 일일 push를 건너뛰며 로그로 남긴다. |
| `GIT_SSH_KEY_PATH` | 미설정 | git의 `GIT_SSH_COMMAND`에서 사용하는 SSH 배포 키 경로다. |
| `GIT_BOT_NAME`, `GIT_BOT_EMAIL` | `도니`, `dony@llmwiki.local` | git 커미터 정보다. |
| `DREAM_CRON` | `0 3 * * *` | 꿈꾸기 실행 일정이다. |
| `TZ_DREAM` | `Asia/Seoul` | 꿈꾸기 일정의 시간대다. |
| `SLACK_WEBHOOK_URL` | 미설정 | 꿈꾸기의 영속 실행 기록이 저장된 뒤 결과·소요 시간·머지 SHA·push 결과만 알리는 선택적 Slack webhook이다. 원문 노트나 작업 입력은 보내지 않는다. |
| `METRICS_TOKEN` | 미설정 | `/metrics` 수집용 Bearer 비밀값이다. 미설정이면 관리자 인증으로만 접근한다. |
| `DEV_LOGIN_EMAIL` | 미설정 | 개발 모드에서만 기존 사용자로 `/auth/dev-login` 로그인을 허용한다. 상용 모드에서 설정하면 시작을 거부한다. |

`DATA_DIR/knowledge`에는 지식 저장소 클론, `DATA_DIR/worktrees`에는 작업 워크트리, `DATA_DIR/llmwiki.db`에는 상태와 검색 인덱스를 둔다. 데이터 경로는 CLI와 서버에서 동일하게 설정해야 한다.

### 로컬 실행과 첫 관리자
Node.js 24와 pnpm 10.34.6, git이 필요하다. `better-sqlite3`의 사전 빌드 바이너리를 사용할 수 없는 환경에서는 Python 3, make, C++ 컴파일러가 필요하다. 다음 명령은 저장소 루트에서 실행한다.

```bash
corepack enable
corepack prepare pnpm@10.34.6 --activate
pnpm install --frozen-lockfile

cp .env.example .env
# .env의 SESSION_SECRET 등 로컬 값을 채운다.
pnpm cli user add admin@example.com --role admin --password
pnpm dev
```

`pnpm dev`와 `pnpm cli`는 저장소 루트의 `.env`가 있으면 Node의 `--env-file-if-exists=.env`로 읽는다. 셸에서 이미 지정한 환경변수가 `.env`보다 우선하므로 `DEV_LOGIN_EMAIL=admin@example.com pnpm dev`처럼 일회성으로 덮어쓸 수 있다. `pnpm dev`는 항상 `NODE_ENV=development`로 실행한다. `.env`에 `NODE_ENV=production`이 남아 있으면 개발 서버가 빌드된 Next 앱을 찾고 개발 로그인을 거부하기 때문이다. 같은 이유로 `.env.example`에는 `NODE_ENV`를 두지 않으며, Docker 이미지와 Compose는 각자 `production`을 고정한다. `pnpm start`는 `.env`를 읽지 않는다.

`pnpm dev` 하나로 API와 UI를 함께 실행하므로 별도 UI 개발 서버를 띄우지 않는다. 서버가 준비되면 `http://localhost:3000/login`에서 등록한 이메일과 비밀번호로 로그인한다. 위 초기 설정에는 Google 설정이나 `DEV_LOGIN_EMAIL`이 필요하지 않다. `/auth/dev-login`은 `DEV_LOGIN_EMAIL`을 지정한 개발 환경에서만 제공하는 선택적 접점이며 기존 사용자만 사용한다. API 키 없이 로컬 인증과 저장소를 확인할 수 있지만 도니의 응답과 임베딩을 확인하려면 `OPENAI_API_KEY`가 필요하다.

Next custom server에는 `PUBLIC_URL`의 호스트 이름과 `PORT`를 전달한다. Next 개발 모드는 이 호스트와 `localhost`를 개발 자산·HMR의 허용 origin으로 사용한다. 이를 생략하면 Next가 `localhost:3000`을 기준으로 초기화되어 `127.0.0.1` 같은 설정된 주소에서 HMR 연결이 거절되고 화면이 로딩 상태에 머무를 수 있다. 브라우저에서는 `PUBLIC_URL`에 설정한 호스트로 접근한다.

`pnpm dev`에서 Next 화면은 HMR로 즉시 갱신되지만 Nest 서버 코드(`src/`)와 SQL 마이그레이션은 프로세스 시작 시 한 번만 로드된다. 따라서 서버 코드를 바꾼 뒤 `pnpm dev`를 다시 시작하지 않으면 새 화면이 아직 없는 API를 호출해 Express 기본 404(`Cannot GET /api/...`)를 받는다. 마이그레이션도 재시작할 때 적용된다. `/readyz`가 404면 재시작 전의 서버가 떠 있는 상태다.

빌드된 서버와 웹을 확인할 때는 `pnpm build` 후 `NODE_ENV=production pnpm start`를 사용한다. 이 모드에서는 개발 로그인을 사용할 수 없지만 등록한 이메일·비밀번호로 로그인할 수 있으므로 Google 설정은 필수가 아니다. 관리자 권한 복구는 `pnpm cli user role admin@example.com admin`, 비밀번호 복구는 `pnpm cli user password admin@example.com`으로 수행한다. 첫 관리자 이후의 사용자·권한·허용 도메인 설정은 웹 관리 화면에서 변경하며 정책은 [인증](auth.md)에 기록한다.

### 개발 서버 출력과 병렬 실행
VS Code의 `pnpm dev` 터미널 출력이 일시 정지되거나 계속 배출되지 않는 상태에서는 동기 TTY 쓰기가 Node 프로세스 전체를 막을 수 있다. 실제로 이 상태에서 Next 화면뿐 아니라 `/healthz`도 응답하지 않는 현상이 관찰됐다. API와 Next가 한 이벤트 루프를 공유하므로 생존 확인 경로도 이 차단을 우회하지 못한다. 이를 DB·git·네트워크 지연으로 단정하기 전에 터미널 출력을 다시 흐르게 하고 로그 소비가 계속되는 실행 환경인지 확인한다.

같은 소스 저장소에서 두 번째 `pnpm dev`를 실행하면 Next가 `web/.next/dev/lock`을 이미 사용 중이라고 보고 시작을 거부한다. 포트나 `DATA_DIR`만 바꾸어도 같은 Next 개발 출력 경로를 사용하므로 해결되지 않는다. 개발 락은 정상 서버 종료로 해제하며 실행 중인 다른 서버의 락을 지우지 않는다.

병렬 확인이 필요하면 독립된 저장소 복사본과 자체 Next 개발 출력 디렉터리를 사용한다. 복사본마다 별도 `DATA_DIR`, `PORT`, 해당 포트의 `PUBLIC_URL`을 지정해 SQLite·지식 저장소·작업 워크트리·PID 파일을 공유하지 않는다. git 머지 직렬화는 프로세스 내부에서 수행하므로 같은 데이터 디렉터리의 여러 서버를 위한 프로세스 간 락으로 해석하지 않는다. 기존 사용자의 서버를 중지하거나 재시작하는 대신 복사본으로 실험한다. 로컬 성능 관찰과 운영 보장을 구분하는 기준은 [읽기 성능](performance.md#측정의-해석)에 기록한다.

복사한 DB로 서버를 실행할 때는 항상 `JOBS_AUTOSTART=false`를 지정한다. 복사본에 남아 있는 대기 작업이나 시작 시 색인 동기화·예약 꿈꾸기가 사용자 요청 없이 실제 OpenAI 비용을 발생시킬 수 있기 때문이다. 데이터 경로·포트 격리만으로 토큰 비용은 격리되지 않는다. 이 설정에서도 직접 채팅·검색이나 관리자 수동 실행은 API를 호출할 수 있으므로 유료 호출을 피하려면 OpenAI 키를 전달하지 않거나 [로컬 fixture](#openai-로컬-테스트-fixture)를 사용한다.

개발 서버 하나는 경로를 컴파일할 때마다 수십 MB씩 커지며 몇 개 화면만 열어도 1~2GB를 쓴다. 확인용으로 띄운 복사본 서버는 확인이 끝나면 반드시 종료한다. 여러 확인 세션이 각자 띄운 서버를 남겨 두면 각 서버가 수 GB까지 커지고, 편집기·브라우저와 함께 호스트 메모리와 스왑을 모두 소진한다. 이 경우 커널 OOM killer가 `oom_score_adj`가 높은 작은 브라우저 프로세스만 반복해 종료하고 큰 Node 프로세스는 남기므로, 호스트가 회복하지 못하고 장시간 멈춘 것처럼 보인다. 서버 측 조회 캐시 타이머로 SSR 요청이 누적되던 원인과 규칙은 [실시간 이벤트](events.md#웹-조회-캐시와-배치-갱신)에 기록한다.

요청이 없는데도 개발 서버가 수십 초 동안 CPU 50% 안팎을 쓰고 RSS가 1GB 가까이 더 올라가는 구간은 Turbopack 영속 캐시(`turbopackFileSystemCacheForDev`, 기본 켜짐)의 저장·압축 작업이다. 22개 라우트를 모두 컴파일한 서버에서 이 작업이 약 10초 동안 tokio 스레드 합계 약 490%를 쓰고 RSS가 2.9GB에서 3.8GB로 올랐다가 저장 후 0.95GB로 내려갔으며, 이후 120초 CPU는 0.05초였다. Nest의 인덱스 폴링과 SSE heartbeat의 유휴 CPU는 1% 미만이었다. Next 16.4의 `turbopackMemoryEviction: 'full'`, 캐시 끄기, `turbopackGc`, `MALLOC_ARENA_MAX=2`는 저장 후 RSS를 의미 있게 줄이지 못해 적용하지 않았으며, Turbopack의 공개 메모리 상한 설정은 없다. 따라서 메모리 대응은 동시에 띄우는 개발 서버 수를 줄이는 것이다.

`turbopack.root`는 단일 루트 패키지의 `node_modules`를 해석하려고 저장소 루트로 둔다. 이 설정에서도 Turbopack은 루트 아래를 전부 재귀 감시하지 않는다. 측정 시 inotify watch 1,770개는 `node_modules`·`web`·`src`에만 있었고 `data/`에는 없었으며, 루트 `data/` 아래에 30초 동안 299회 써도 CPU 증가는 0.01초였다.

Next 16 개발 모드는 HTML 요청마다 React 디버그 채널을 메모리에 두고, 해당 페이지의 HMR WebSocket이 연결 후 닫힐 때만 지운다. 따라서 `curl` 같은 HTML 조회나 hydration 전에 닫힌 페이지는 요청당 약 50KB를 프로세스 종료까지 남긴다. 반복 생존 확인에는 HTML 화면 대신 `/healthz`나 `/readyz`를 사용한다. 이 누적은 Next 개발 서버 내부 동작이며 운영 빌드와는 관계없다.

### Docker 이미지와 영속 볼륨
Dockerfile은 `node:24-bookworm-slim` 기반의 두 단계 빌드를 사용한다. 빌드 단계에서 루트 의존성을 frozen lockfile로 한 번 설치하고 `pnpm build`를 실행한 뒤 개발 의존성을 제거한다. 실행 단계에는 서버와 Next에 필요한 루트 운영 의존성, `dist/`, `skills/`, `web/.next/`, `web/public/`, Next 설정을 복사하며 git, openssh-client, tini를 설치한다. Nest와 Next를 같은 Node 프로세스에서 실행하므로 Next standalone 서버나 별도 웹 컨테이너는 사용하지 않는다.

실행 사용자는 root가 아닌 `node`다. tini가 PID 1에서 신호와 자식 프로세스를 처리하며 `node dist/main.js`를 실행한다. `llmwiki` 실행 파일은 `PATH`에 있으므로 컨테이너 안에서도 관리 명령을 직접 호출할 수 있다. 이미지 healthcheck는 초기 인덱스와 저장소 준비를 확인하는 `/readyz`를 사용하며 `/healthz`는 프로세스 생존 확인용으로 유지한다.

다음은 **로컬 이미지 확인용** 예시다. 이미지는 `NODE_ENV=production`에서 빌드된 Next 앱을 제공하므로 개발 모드로 덮어쓰거나 `DEV_LOGIN_EMAIL`을 전달하지 않는다. Google 로그인까지 확인하려면 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, 등록된 리디렉션 주소에 맞는 `PUBLIC_URL`을 실행 환경으로 추가한다.

```bash
docker build -t llmwiki-engine:local .
docker volume create llmwiki-local-data
export LOCAL_SESSION_SECRET="$(openssl rand -hex 32)"
docker run -d --name llmwiki-local \
  -p 127.0.0.1:3000:3000 \
  -v llmwiki-local-data:/data \
  -e SESSION_SECRET="$LOCAL_SESSION_SECRET" \
  llmwiki-engine:local
docker exec -it llmwiki-local llmwiki user add admin@example.com --role admin --password
curl --fail http://localhost:3000/readyz
```

관리자와 비밀번호를 등록한 뒤 `PUBLIC_URL`의 `/login`에서 이메일·비밀번호로 로그인한다. Google 설정을 추가한 경우 같은 화면에서 Google 로그인도 선택할 수 있다. 비밀번호 변경은 `docker exec -it llmwiki-local llmwiki user password admin@example.com`으로 수행한다. 이미지 실행에 OpenAI 기능이 필요하면 `OPENAI_API_KEY`를 실행 환경으로 전달한다. `/data`를 named volume으로 보존하면 컨테이너를 다시 만들어도 지식과 SQLite 상태를 유지한다. 호스트 디렉터리를 bind mount할 경우 이미지의 `node` 사용자 UID/GID가 쓰기 가능한 권한을 미리 설정해야 한다. 볼륨 전체 백업과 지식 저장소의 git 원격 백업은 서로 다른 범위를 보호한다.

SSH 키는 이미지에 복사하지 않는다. 원격 git이 필요할 때는 키와 검증된 `known_hosts`를 실행 사용자에게 읽기 가능한 읽기 전용 마운트로 제공하고 `GIT_SSH_KEY_PATH`를 설정한다. `.dockerignore`는 git 메타데이터, 설치·빌드 결과, 로컬 데이터, 환경 파일, SSH 디렉터리와 키 파일을 빌드 컨텍스트에서 제외한다.

### 로컬 Compose 프로필
루트 `compose.yaml`의 `dev` 프로필은 로컬 소스로 이미지를 빌드하고 named volume에 데이터를 보존한다. 프로필 이름은 개발자의 로컬 이미지 검증을 뜻하며 컨테이너 자체는 빌드된 웹을 제공하는 `NODE_ENV=production`으로 실행한다. 개발 로그인은 비활성화한다.

```bash
cp .env.example .env
# .env의 SESSION_SECRET에 로컬에서 생성한 무작위 값을 기록한다.
docker compose --profile dev up --build -d
docker compose --profile dev exec llmwiki llmwiki user add admin@example.com --role admin --password
docker compose --profile dev ps
docker compose --profile dev down
```

`.env.example`은 비밀값 없는 변수 목록이며 `.env`는 로컬 비밀값을 담고 커밋하지 않는다. 컨테이너의 데이터 경로와 포트는 `/data`, `3000`으로 고정하고 호스트 수신 포트만 `.env`의 `PORT`로 선택한다. 호스트의 `127.0.0.1`에만 포트를 열며 SSH 키나 배포 작업은 자동 구성하지 않는다. `down`은 named volume을 삭제하지 않으며 `down -v`는 데이터를 삭제하므로 백업 없이 실행하지 않는다.


## 관련 문서
- [엔진 아키텍처](architecture.md)는 단일 컨테이너와 SQLite 선택의 배경을 설명한다.
- [인증](auth.md)은 관리자 부트스트랩 이후 적용되는 사용자와 로그인 정책을 설명한다.
- [지식 저장소](knowledge-repository.md)는 영속 지식의 구조와 원격 백업 범위를 설명한다.
- [웹](web.md), [MCP](mcp.md), [RAG](rag.md)는 각 모듈의 외부 계약을 설명한다.
- [읽기 성능과 캐시 경계](performance.md)는 조회 캐시와 전송·렌더링 최적화 및 로컬 측정의 한계를 설명한다.
