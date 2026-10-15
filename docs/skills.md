# 설치형 Skills
설치형 Skills는 Claude Code, Codex, Hermes에 공통 지식 활용 프롬프트를 설치하며, 설정의 MCP 탭은 일곱 종류의 클라이언트 연결을 안내한다.

## 배경
MCP 연결만으로는 클라이언트가 언제 지식을 검색하고 무엇을 저장해야 하는지 충분히 안내하지 못한다. Skill은 기존 지식을 먼저 활용하고, 재사용할 가치가 있는 결정·이유·동작·문제 해결 지식을 능동적으로 제출하도록 안내한다. Hermes는 Nous Research의 Hermes Agent를 뜻한다.

Skill 설치와 MCP 연결·OAuth 로그인은 별개다. 설치기는 로그인하거나 비밀값을 저장하지 않으며, 기존 클라이언트 설정을 수정하지 않는다. 프롬프트 배치만으로 엔진 연결이 완료되었다고 간주하지 않는다.

## 내용
### 엔진에서 한 명령으로 설치와 갱신
엔진의 공개 URL만 있으면 저장소를 복제하지 않고 macOS와 Linux에서 설치한다. `<ENGINE_URL>`은 실제 엔진 주소로 바꾸며, 마지막 클라이언트는 `claude-code`, `codex`, `hermes` 중에서 선택한다.

```bash
curl -fsSL <ENGINE_URL>/skills/install.sh | sh -s -- install claude-code
curl -fsSL <ENGINE_URL>/skills/install.sh | sh -s -- install codex --project /path/to/project
curl -fsSL <ENGINE_URL>/skills/install.sh | sh -s -- status codex --project /path/to/project
curl -fsSL <ENGINE_URL>/skills/install.sh | sh -s -- update codex --project /path/to/project
```

POSIX `sh`, 기본 파일 도구, `awk`, `sha256sum` 또는 macOS의 `shasum -a 256`, `curl` 또는 `wget`이 필요하다. Git, Node.js, pnpm, Python과 엔진 빌드는 필요 없다. `wget -qO- <ENGINE_URL>/skills/install.sh | sh -s -- install codex`도 가능하다. 설치기는 MCP 설정·OAuth 로그인·Hermes 프로젝트 신뢰 승인을 수행하지 않고 별도 단계를 출력한다.

`install`, `status`, `update`는 선택적인 `--project <dir>`, `--force`를 받는다. `--force`의 수정 보호 경계와 상태는 [기존 설치와 로컬 수정 보호](#기존-설치와-로컬-수정-보호)를 따른다. 다른 엔진에서 자료를 받으려면 파이프 오른쪽에 `LLMWIKI_URL=https://other.example.com sh -s -- install codex`를 지정한다. 이 변수는 다운로드 주소만 바꾸며 MCP 연결 주소를 저장하지 않는다.

공개 `GET /skills/install.sh`는 하나의 정본 `skills/install.sh`에 서버 설정 `PUBLIC_URL`의 끝 슬래시를 제거한 주소를 셸 인용해 넣는다. 요청의 `Host`·전달 헤더로 주소를 계산하지 않는다. 같은 스크립트가 복제본에서는 로컬 자료를, 표준 입력에서는 엔진 자료를 사용한다. `GET /skills/manifest/<client>`는 버전·설치 파일별 SHA-256을, `GET /skills/files/<sha256>`는 해당 배포 파일의 원본 바이트를 제공하며 `GET /skills/version.json`은 배포 버전 원본을 제공한다. 서버는 공통 `SKILL.md`와 세 클라이언트 자료만 시작 시 읽어 보관하므로 요청 경로로 저장소 파일을 탐색하지 않으며 경로 순회를 허용하지 않는다.

원격 설치는 모든 파일을 비공개 임시 디렉터리에 내려받고 각 SHA-256을 manifest와 대조한 뒤 기존 설치 보호 검사와 쓰기를 시작한다. 다운로드 실패·체크섬 불일치에서는 대상 파일과 설치 표식을 전혀 바꾸지 않는다. 원본 바이트를 그대로 내려받으므로 마지막 줄바꿈이 없는 파일·바이너리도 셸·CLI 설치와 동일하다. 스크립트와 manifest·파일 응답은 `Cache-Control: public, max-age=60`을 사용한다. 체크섬은 전송 일관성 검사이며 엔진 신뢰나 HTTPS를 대체하지 않는다.

### 저장소만으로 설치와 갱신
Skill만 사용할 때는 엔진 의존성 설치나 실행이 필요 없다. Git으로 저장소를 받은 뒤 POSIX `sh`와 기본 파일·SHA-256 도구로 설치한다. Node.js, pnpm, Python과 빌드는 필요 없다. 다음 명령은 저장소 상위 디렉터리에서 실행하며 마지막 클라이언트를 `codex` 또는 `hermes`로 바꾸어 사용할 수 있다.

```bash
git clone https://github.com/BitbyteCorp/llmwiki-engine.git \
  && sh llmwiki-engine/skills/install.sh install claude-code
```

비공개 저장소는 먼저 GitHub 접근 권한과 Git 인증을 준비한다. 이미 받은 저장소에서는 `git pull --ff-only`로 배포 자료를 갱신한 뒤 루트에서 다음 명령을 사용한다. `install`, `status`, `update`는 모두 `<claude-code|codex|hermes>`, 선택적인 `--project <dir>`, `--force`를 받는다.

```bash
sh skills/install.sh install codex --project /path/to/project
sh skills/install.sh status codex --project /path/to/project
sh skills/install.sh update codex --project /path/to/project
```

### 기존 CLI와 설치 위치
엔진을 이미 설치한 환경의 빌드된 CLI는 `llmwiki skill`을 사용하며, 엔진 개발 환경에서는 `pnpm cli skill`을 사용한다. Skill 설치를 위해 엔진을 빌드하지 않는다. 원격·저장소 셸 설치기와 기존 CLI는 아래 설치 위치와 `.llmwiki-install.json` 표식·해시·수정 보호 계약을 공유하므로 서로 설치한 결과를 조회하고 갱신할 수 있다.

```bash
llmwiki skill install claude-code
llmwiki skill install codex --project /path/to/project
llmwiki skill install hermes --project /path/to/project
llmwiki skill status codex --project /path/to/project
llmwiki skill update codex --project /path/to/project
```

| 클라이언트 | 개인 설치 | `--project <dir>` 설치 |
|---|---|---|
| Claude Code | `~/.claude/skills/llmwiki` | `<dir>/.claude/skills/llmwiki` |
| Codex | `~/.agents/skills/llmwiki` | `<dir>/.agents/skills/llmwiki` |
| Hermes | `~/.hermes/skills/llmwiki` | `<dir>/.hermes/skills/llmwiki` |

위치는 [Claude Code Skills](https://code.claude.com/docs/en/skills), [Codex Skills](https://developers.openai.com/codex/skills), [Hermes Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills#project-local-skills)의 클라이언트 규칙을 따른다. Hermes 프로젝트 대상은 `.git`이 있는 프로젝트 루트이며, 설치 후 사용자가 별도로 `hermes skills trust <dir>`를 실행해야 자동 로딩된다. 설치기는 프로젝트 신뢰 설정을 바꾸지 않는다. 한 클라이언트의 같은 이름을 여러 범위에 설치하면 우선순위에 따라 다른 복사본이 선택될 수 있으므로 의도한 범위의 상태를 확인한다.

설치 디렉터리에는 다음 파일을 둔다.

- `SKILL.md`는 [`skills/llmwiki/SKILL.md`](../skills/llmwiki/SKILL.md)의 공통 원본을 복사한 파일이다. 저장소에서는 클라이언트별 프롬프트 복제본을 유지하지 않는다.
- `client/`에는 선택한 클라이언트의 `skills/<client>/` 자료를 원래 상대 경로대로 복사한다. README와 MCP 병합 예시는 참고 자료이며 활성 클라이언트 설정이 아니다. Claude 플러그인 manifest는 이 디렉터리에 복사하지 않는다.
- `.llmwiki-install.json`은 설치기 스키마, 클라이언트, 설치 버전, 관리 파일별 SHA-256을 기록한다. 비밀값이나 OAuth 토큰을 기록하지 않는다.

공통 원본과 클라이언트 자료의 배포 버전은 `skills/version.json`에서 관리한다. 프롬프트뿐 아니라 실제 설치하는 README·MCP 예시가 바뀌어도 배포 버전을 올린다. 설치 대상이 아닌 설치기 자체만 바뀌면 배포 버전은 유지한다. Claude 플러그인의 `skills/.claude-plugin/plugin.json`의 `version`과 마켓플레이스의 `.claude-plugin/marketplace.json`의 `metadata.version`도 같은 값으로 갱신한다. 호스팅한 Claude 플러그인은 manifest 버전으로 캐시를 갱신하므로 내용만 바꾸고 버전을 유지하지 않는다.

복제본의 셸 설치기는 스크립트 위치로 원본 `skills/`를 찾는다. 기존 TypeScript 설치기와 공개 배포 서비스는 모듈 위치 기준 `../../skills/`를 읽으므로 개발의 `src/skill`과 빌드의 `dist/skill`에서 모두 저장소 루트의 자료를 사용한다. 현재 작업 디렉터리에 의존하지 않는다. 빌드 배포물은 `dist/`와 함께 루트 `skills/`를 포함해야 하며, Docker 런타임도 이 디렉터리를 복사한다.

### 기존 설치와 로컬 수정 보호
명령은 JSON 상태를 출력한 뒤 수행하지 않은 MCP/OAuth 단계를 별도로 출력한다. `installedVersion`, `availableVersion`, `directory`, `modifiedFiles`, `unmanagedFiles`로 설치 위치와 수정 파일을 확인한다.

| 상태 | 의미 |
|---|---|
| `not-installed` | 대상 디렉터리가 없다. |
| `unmanaged` | 유효한 설치 표식이 없거나 새 배포 파일과 충돌하는 관리 외 파일이 있다. |
| `modified` | 관리 파일이 설치 당시의 해시와 다르거나 삭제되었다. |
| `outdated` | 로컬 수정은 없지만 배포 버전이나 배포 파일 집합·내용이 다르다. |
| `current` | 설치 버전과 관리 파일 내용이 현재 배포물과 같다. |

`install`은 새 설치를 만들거나 보호 규칙에 따라 기존 설치를 갱신한다. `update`는 기존 설치만 갱신하며 대상이 없으면 `install`을 안내한다. 최신 설치에서는 파일을 다시 쓰지 않는다. `status`는 파일을 쓰지 않으며 `--force`도 상태 조회에서는 효과가 없다. 버전 숫자가 같아도 배포 파일 내용이 달라지면 갱신 필요 상태로 판단한다.

파일 쓰기 전에 모든 대상 파일을 확인한다. 관리 파일의 로컬 수정·삭제와 기존 관리 외 파일의 덮어쓰기는 기본적으로 거부한다. 표식 없는 기존 `SKILL.md`도 내용이 원본과 같더라도 사용자 파일로 취급한다. 수정 내용을 검토·백업한 뒤 `--force`를 지정하면 충돌한 Skill 파일과 설치 표식을 교체할 수 있다. 제거된 배포 파일은 이전 표식이 관리하던 파일만 삭제하며, 수정된 파일을 지우는 경우에도 `--force`가 필요하다. 관계없는 추가 파일은 남긴다. 심볼릭 링크와 파일 대신 존재하는 디렉터리는 `--force`로도 교체하지 않는다.

`--force`는 엔진 환경 설정, `~/.codex/config.toml`, `~/.hermes/config.yaml`, 프로젝트의 활성 `.mcp.json`, OAuth 저장소를 덮어쓰는 옵션이 아니다. 예시 파일은 설치 디렉터리의 `client/`에만 둔다.

### 클라이언트 기본 배포 경로
기본 설치 도구를 선호하면 다음 경로를 사용한다. 이 경로들은 해당 클라이언트가 설치·갱신을 소유하며 `.llmwiki-install.json`을 만들지 않는다. 셸·CLI 설치기와 같은 대상에 겹쳐 설치하지 않는다. 기본 설치 결과를 셸·CLI로 전환할 때는 기존 내용을 검토·백업하고 관리되지 않은 파일 보호 규칙을 따른다. 어느 경로도 MCP 등록이나 OAuth 로그인을 대신하지 않는다.

#### Claude Code 마켓플레이스
[공식 마켓플레이스 생성 문서](https://code.claude.com/docs/en/plugin-marketplaces)와 [마켓플레이스 참조](https://code.claude.com/docs/en/plugins/marketplace-reference)에 따라 Claude Code에서 다음 명령을 실행한다.

```text
/plugin marketplace add BitbyteCorp/llmwiki-engine
/plugin install llmwiki@llmwiki-engine
```

셸에서는 `claude plugin marketplace add https://github.com/BitbyteCorp/llmwiki-engine.git`와 `claude plugin install llmwiki@llmwiki-engine`을 사용할 수 있다. 저장소 접근 권한은 별도로 필요하다. 기본 설치 범위는 사용자이며 팀 프로젝트 범위는 공식 설치 명령의 `--scope project`를 선택한다. 새 세션에서 플러그인의 이름 공간이 붙은 `/llmwiki:llmwiki`를 호출한다. 셸·CLI로 설치한 독립 Skill의 `/llmwiki`와 구분한다.

루트 `.claude-plugin/marketplace.json`의 `source: "./skills"`는 마켓플레이스 루트 기준으로 `skills/`만 플러그인 원본으로 선택한다. 저장소 전체를 플러그인으로 복사하지 않으므로 엔진 데이터·의존성 디렉터리를 플러그인 캐시에 넣지 않는다. `skills/.claude-plugin/plugin.json`의 `skills: ["./llmwiki"]`는 [공식 manifest 참조](https://code.claude.com/docs/en/plugins-reference)가 허용하는 `SKILL.md`를 직접 담은 디렉터리이며 캐시 루트 안에서 정본을 찾는다. `../`나 캐시 밖 심볼릭 링크, 임시 플러그인 생성과 프롬프트 복제본은 필요 없다.

`strict: true`를 명시하고 구성 요소는 플러그인 manifest에서만 선언한다. 공식 참조에 따르면 manifest가 없으면 마켓플레이스 항목이 manifest가 되고, 현재 참조의 `strict: false`는 manifest와 마켓플레이스 양쪽의 구성 요소 선언이 충돌하는 경우 로딩을 거부한다. 이 저장소는 중복 선언에 의존하지 않는다. 플러그인 루트에 `.mcp.json`을 두지 않고 `mcpServers`도 선언하지 않으므로 설치가 서버를 자동 등록하지 않는다. 갱신은 `claude plugin marketplace update llmwiki-engine` 다음 `claude plugin update llmwiki@llmwiki-engine`으로 수행한다.

#### Codex GitHub Skill 설치
[공식 Codex Skills 문서](https://developers.openai.com/codex/skills)는 `$skill-installer`로 다른 저장소의 Skill을 설치할 수 있다고 안내한다. Codex 대화에서 다음과 같이 요청한다.

```text
$skill-installer install the skill from https://github.com/BitbyteCorp/llmwiki-engine/tree/main/skills/llmwiki
```

정확한 원본은 `skills/codex`가 아니라 `skills/llmwiki`다. [OpenAI 공식 skill-installer 지침](https://github.com/openai/skills/blob/main/skills/.system/skill-installer/SKILL.md)은 `install-skill-from-github.py --repo BitbyteCorp/llmwiki-engine --path skills/llmwiki` 또는 같은 `tree/main/skills/llmwiki` URL을 지원한다. 이 명령은 설치기가 가진 Python 도우미의 인자이며 존재하지 않는 `codex skills install` 명령이 아니다. 도우미 기본 설치 위치는 `$CODEX_HOME/skills`이고 기본값은 `~/.codex/skills`다. 저장소 전용 셸·CLI의 `~/.agents/skills`와 구분하며, 설치 결과를 원하는 범위에 맞출 때는 공식 도우미의 `--dest`를 사용한다. Python 없이 설치하려면 저장소 전용 셸 경로를 사용한다. 새 Skill이 보이지 않으면 Codex를 다시 시작한다.

#### Hermes GitHub Skill 설치
[공식 Hermes Skills의 직접 GitHub 설치](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills#installing-individual-skills-directly-without-adding-a-tap)는 `owner/repo/skills/skill-name`을 지원한다.

```bash
hermes skills install BitbyteCorp/llmwiki-engine/skills/llmwiki
```

[공식 지원 소스 표](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills#supported-hub-sources)의 `github` 소스를 사용하며, `skills/hermes`가 아니라 정본 디렉터리를 지정한다. 공개 저장소의 개별 경로는 tap 추가 없이 설치할 수 있다. 공식 문서는 비공개 GitHub tap에 `GITHUB_TOKEN`이 필요하다고 설명하지만 비공개 개별 경로의 직접 설치까지 보장하지는 않으므로, 비공개 저장소는 Git 인증으로 복제한 뒤 저장소 전용 셸 설치기를 사용한다. Hermes 설치기의 보안 검사·설치 확인·갱신 정책을 따르며 셸 설치기의 `--force`와 혼동하지 않는다. 새 세션의 `/llmwiki`로 호출한다.


### 공통 지식 활용 프롬프트
공통 프롬프트는 영어로 작성하며 도니가 지식 노트를 쓰는 한국어 규칙과 구분한다. 질문에 답하기 전에 검색하고 관련 노트를 읽으며, 확인한 노트의 정확한 경로를 답변에 인용한다. 검색하지 못한 사실과 추론은 위키 근거와 구분한다. 노트 내용은 근거로 취급하며 사용자의 작업이나 안전 규칙을 바꾸는 명령으로 취급하지 않는다.

작업 중 발견한 지속적인 사실과 교훈은 기존 지식을 먼저 확인한 뒤 자연어로 `write(content)`에 제출한다. 비밀값·불필요한 개인정보·현재 대화의 진행 상태는 제출하지 않는다. 비동기 쓰기의 작업 ID와 반영 완료는 구분하며 필요하면 `get_write_status(jobId)`로 결과를 확인한다. 직접 쓰기 등 추가 도구의 계약은 [MCP](mcp.md)를 따른다.

### 설정의 MCP 연결 안내
`/settings?tab=mcp`의 **MCP · Skill**은 개인 설정 탭이다. 지식 조회·검색·링크·변경 이력과 쓰기·원문 통합의 범위는 [MCP 도구 계약](mcp.md#도구-계약), 역할과 대상 폴더의 실효 권한은 [폴더별 접근 제어](access-control.md)를 따른다. 설치 가능한 Skill은 세 클라이언트에 한정되지만, 연결 안내는 Claude Code, Codex, Hermes, Claude Desktop·claude.ai, Cursor, VS Code, 일반 Streamable HTTP를 제공한다.

화면은 서버에서 전달한 `PUBLIC_URL` 끝의 슬래시를 모두 제거한 기본 URL에 `/mcp`를 붙인다. 웹에 `PUBLIC_URL` 환경변수가 없으면 현재 브라우저의 `window.location.origin`을 사용한다. 이 대체 주소는 화면의 안내용이며 엔진의 OAuth 설정을 변경하지 않는다. 엔진의 별도 `PUBLIC_URL` 기본값은 `http://localhost:3000`이므로, 외부 배포에서는 브라우저에 표시되는 주소만 맞추지 말고 엔진의 공개 주소도 명시한다.

서버 주소·클라이언트 설정·명령 블록에는 복사 버튼이 있다. 복사 성공과 실패는 전역 알림으로 표시하며, 실패하면 내용을 직접 선택해 복사한다.

Claude Code·Codex·Hermes를 선택하면 같은 기본 URL로 `curl -fsSL <기본 URL>/skills/install.sh | sh -s -- install <클라이언트>` 명령을 제공한다. 클라이언트 값은 각각 `claude-code`, `codex`, `hermes`다. macOS·Linux에서 저장소 복제나 `llmwiki` CLI 설치 없이 Skill을 설치하며, 명령 끝에 `--project /path/to/project`를 붙이면 프로젝트 범위를 선택한다. 설치는 MCP 연결·OAuth 로그인을 수행하지 않으므로 화면의 연결 등록과 로그인 단계를 별도로 완료한다. 저장소·CLI·클라이언트 기본 설치 경로는 이 문서의 다른 절에서 안내한다.

**연결 확인**은 기본 URL의 origin에서 다음 두 발견 문서만 가져온다.

| 요청 | 검사 필드 | 화면이 기대하는 값 |
| --- | --- | --- |
| `GET /.well-known/oauth-protected-resource` | `resource` | 화면에 표시한 전체 MCP URL이다. |
| `GET /.well-known/oauth-authorization-server` | `issuer` | 끝의 슬래시를 제거한 기본 URL이다. |

검사는 JSON 문자열 필드를 읽고 비교할 두 주소의 마지막 슬래시를 제거해 값과 통과·실패를 표시한다. 네트워크·HTTP 오류나 누락된 값도 실패로 표시한다. 이 버튼은 OAuth 로그인, 토큰 발급, `initialize`, 실제 도구 호출을 하지 않으므로 통과가 로그인이나 도구 실행 성공을 뜻하지 않는다. 서버의 발견 문서와 인가 흐름 자체는 [MCP OAuth](auth.md#mcp의-oauth-인가-서버)에 기록한다.

### 별도 MCP 연결과 OAuth
아래 `<ENGINE_URL>`과 예시 도메인 `https://wiki.example.com`은 [설정 안내가 계산한 기본 URL](#설정의-mcp-연결-안내)로 바꾼다. 기존 서버 목록을 통째로 덮어쓰지 않고 `llmwiki` 항목만 병합하며, 이미 같은 이름의 항목이 있으면 중복 선언하지 않고 수정한다. 정적 토큰이나 비밀값을 예시 파일에 넣지 않는다.

API 토큰 탭의 REST 자동화와 MCP 클라이언트의 브라우저 로그인은 구분한다. MCP 설정에 넣을 토큰의 경계는 [REST API 토큰과 MCP OAuth의 비호환 계약](auth.md#rest-api-토큰)을 따른다. Google 로그인 결과를 MCP 자격 증명으로 복사하지 않는 이유는 [엔진의 OAuth 인가 서버](auth.md#mcp의-oauth-인가-서버)에 설명한다. OAuth 발견 문서가 광고하는 permission scope는 `mcp`이며, 아래 Claude Code의 `--scope user|project`는 클라이언트 설정을 적용할 범위이지 OAuth 권한 범위가 아니다.

#### Claude Code
[공식 MCP 문서](https://code.claude.com/docs/en/mcp)에 따라 개인 연결은 다음 명령으로 별도 등록한다. 프로젝트 연결은 `--scope project`를 사용하며 사용자 승인 절차를 거친다.

```bash
claude mcp add --transport http --scope user llmwiki "<ENGINE_URL>/mcp"
```

Claude Code에서 `/mcp`를 열어 브라우저 OAuth 인증을 완료한다. 새 세션에서 셸·CLI 설치는 `/llmwiki`, 마켓플레이스 설치는 `/llmwiki:llmwiki`로 호출한다. 플러그인은 MCP 서버를 자동 등록하지 않으며 임시 플러그인이나 `LLMWIKI_URL` 환경변수 설정도 필요 없다. 클라이언트별 절차는 [Claude Code 자료](../skills/claude-code/README.md)를 따른다.

#### Codex
[공식 MCP 문서](https://developers.openai.com/codex/mcp)에 따라 기존 `~/.codex/config.toml` 또는 신뢰한 프로젝트의 `.codex/config.toml`에 `client/mcp.example.toml`의 테이블을 병합한다.

```toml
[mcp_servers.llmwiki]
url = "https://wiki.example.com/mcp"
```

`codex mcp login llmwiki`로 브라우저 OAuth 로그인을 완료한다. 새 세션의 `/mcp`로 연결을 확인하고 `/skills` 또는 `$llmwiki`로 Skill을 호출한다.

#### Hermes
[공식 MCP 문서](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)에 따라 기존 `~/.hermes/config.yaml`의 `mcp_servers`에 `client/mcp.example.yaml`의 `llmwiki` 항목을 병합한다.

```yaml
mcp_servers:
  llmwiki:
    url: "https://wiki.example.com/mcp"
    auth: oauth
```

별도 터미널에서 `hermes mcp login llmwiki`로 브라우저 OAuth 로그인을 완료한다. 새 세션에서 `/llmwiki`를 호출한다. 기존 세션의 `/reload-mcp`는 MCP 연결 재로드이며 새 Skill 반영과 구분한다. 브라우저와 Hermes가 다른 호스트에 있으면 공식 문서의 원격 콜백 절차를 따른다.

#### Claude Desktop · claude.ai
[공식 원격 커넥터 문서](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)에 따라 개인 계정은 **Customize → Connectors → Add custom connector**에서 이름 `llmwiki`와 전체 MCP URL을 등록한다.

```text
https://wiki.example.com/mcp
```

**Continue**에서 발견된 OAuth 설정을 확인하고 **Sign in now**로 로그인한다. 엔진의 DCR을 사용하려면 **Register automatically**를 선택한다. Team·Enterprise는 조직 소유자가 커넥터를 등록한 뒤 사용자가 개별 연결한다.

Claude Desktop의 원격 커넥터도 로컬 PC가 아니라 Anthropic 클라우드에서 엔진에 접속한다. 공개 HTTPS 엔진 주소가 필요하며 `localhost`와 클라우드에서 접근할 수 없는 사설망 주소를 직접 사용할 수 없다. 로컬 Desktop 서버 설정과 이 원격 커넥터를 혼동하지 않는다.

#### Cursor
[공식 MCP 문서](https://cursor.com/docs/mcp)에 따라 개인 설정 `~/.cursor/mcp.json` 또는 프로젝트 설정 `.cursor/mcp.json`의 기존 `mcpServers`에 다음 항목을 병합한다.

```json
{
  "mcpServers": {
    "llmwiki": {
      "url": "https://wiki.example.com/mcp"
    }
  }
}
```

설정 안내가 사용하는 Cursor 형식은 `url`이며 `type` 필드를 추가하지 않는다. Customize의 MCP 도구 화면에서 연결하고 브라우저 OAuth 인증을 완료한다.

#### VS Code
[공식 MCP 설정 문서](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)에 따라 워크스페이스 `.vscode/mcp.json`의 기존 `servers`에 다음 항목을 병합한다. Cursor의 `mcpServers`와 달리 VS Code 안내는 `servers`와 `type: "http"`를 사용한다.

```json
{
  "servers": {
    "llmwiki": {
      "type": "http",
      "url": "https://wiki.example.com/mcp"
    }
  }
}
```

MCP 서버를 시작하고 서버 신뢰 확인과 브라우저 OAuth 인증을 완료한 뒤 에이전트 도구 목록을 확인한다.

#### 일반 Streamable HTTP
Streamable HTTP와 OAuth를 지원하는 클라이언트에 전체 MCP URL을 등록한다. [인증 흐름](auth.md#mcp-로그인-흐름)에 따른 발견·PKCE 브라우저 로그인·엔진 토큰 발급을 마친 뒤 `initialize`와 `tools/list`로 시작한다. 요청 헤더, 서버의 stateless 동작과 명세 버전 차이는 [MCP 전송 계약](mcp.md#제공-범위와-전송)을 따른다. 헤더를 임의로 고정하지 않고 협상한 프로토콜 버전에 맞춰 클라이언트 SDK가 구성하게 한다.

### 설치부터 실제 사용 확인까지
1. Skill을 지원하는 클라이언트는 [엔진 한 명령 설치](#엔진에서-한-명령으로-설치와-갱신), [저장소 전용 설치](#저장소만으로-설치와-갱신), [기본 배포 경로](#클라이언트-기본-배포-경로) 중 하나를 선택한다. 셸·CLI 설치는 같은 범위로 `status`와 `update`를 사용한다. Hermes 프로젝트 설치의 Git 루트와 별도 신뢰 승인은 [설치 위치](#기존-cli와-설치-위치)를 따른다.
2. [클라이언트별 MCP 연결](#별도-mcp-연결과-oauth)을 등록하고 브라우저 OAuth 로그인을 별도로 완료한다. 원격 호스트에서 실행하는 클라이언트는 각 공식 문서의 콜백 안내를 따른다.
3. 새 클라이언트 세션에서 지식 질문으로 `search`와 `read_note`를 실행하고 답변에 실제 노트 경로가 인용되는지 확인한다. Skill이나 서버 목록에 이름이 보이는 것만으로 실제 도구 실행 성공을 판단하지 않는다.
4. 쓰기 완료를 검증할 때는 [비동기 쓰기 확인](mcp.md#쓰기-입력)에 따라 반환된 `jobId`로 `get_write_status`의 `succeeded`를 확인한다. 설치·로그인·작업 접수는 각각 저장 완료와 구분한다.

### 연결 문제 해결
| 증상 | 확인할 사항 |
| --- | --- |
| 발견 검사 실패 또는 `resource`·`issuer` 불일치 | [설정 안내의 기대 주소](#설정의-mcp-연결-안내)와 실제 `PUBLIC_URL`, 클라이언트 URL, 프록시 외부 주소·HTTPS 설정을 대조한다. |
| HTTP 401 | 클라이언트에서 OAuth 로그인을 다시 수행하고 [토큰 종류의 경계](auth.md#rest-api-토큰)를 확인한다. |
| 조회자의 쓰기 거절 | [MCP 도구 오류와 권한](mcp.md#도구-오류와-권한)을 확인한다. |
| 특정 폴더의 조회·쓰기 실패 | 사용자 역할과 [폴더 접근 권한](access-control.md)을 함께 확인한다. |
| 프록시를 거친 요청이 지연되거나 끊김 | 프록시 응답 버퍼링·요청 시간 제한과 [필수 Accept 헤더](mcp.md#제공-범위와-전송)를 확인한다. |
| Claude 원격 커넥터에서 로컬 주소 연결 실패 | [클라우드 커넥터의 공개 HTTPS 요구](#claude-desktop--claudeai)를 확인한다. |

## 관련 문서
- [MCP](mcp.md)는 지식 도구와 리소스, 요청 헤더와 전송 계약을 설명한다.
- [쓰기 흐름](write-flow.md)은 제출한 지식을 반영하는 절차를 설명한다.
- [인증](auth.md)은 엔진 로그인과 MCP OAuth 계약을 설명한다.
- [개발 환경](development.md)은 빌드와 CLI 실행 방법을 설명한다.
