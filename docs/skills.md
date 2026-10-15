# 설치형 Skills
설치형 Skills는 여섯 설치 대상으로 18개 에이전트 접점의 공통 지식 활용 프롬프트를 배치하며, 설정의 MCP 탭은 Skill 전용 항목을 포함한 20개 클라이언트 선택지를 제공한다.

## 배경
MCP 연결만으로는 클라이언트가 언제 지식을 검색하고 무엇을 저장해야 하는지 충분히 안내하지 못한다. Skill은 기존 지식을 먼저 활용하고, 재사용할 가치가 있는 결정·이유·동작·문제 해결 지식을 능동적으로 제출하도록 안내한다. Hermes는 Nous Research의 Hermes Agent를 뜻한다.

Skill 설치와 MCP 연결·OAuth 로그인은 별개다. 설치기는 로그인하거나 비밀값을 저장하지 않으며, 기존 클라이언트 설정을 수정하지 않는다. 프롬프트 배치만으로 엔진 연결이 완료되었다고 간주하지 않는다.

## 내용
### 엔진에서 한 명령으로 설치와 갱신
엔진의 공개 URL만 있으면 저장소를 복제하지 않고 macOS와 Linux에서 설치한다. `<ENGINE_URL>`은 실제 엔진 주소로 바꾼다. 인수 없이 실행하면 터미널에서 클라이언트와 개인·프로젝트 범위를 선택한다.

```bash
curl -fsSL <ENGINE_URL>/skills/install.sh | sh
```

메뉴에는 각 설치 위치를 함께 읽는 에이전트 이름을 표시한다. 공유 `.agents/skills` 대상은 `codex`로 한 번만 설치하며 이름별 별칭이나 중복 설치를 만들지 않는다. 기본값은 Claude Code와 개인 범위이며, 프로젝트 디렉터리의 기본값은 현재 디렉터리다. Hermes 프로젝트는 `.git`이 있는 루트를 지정한다. 복제본에서는 선택 전에 개인 범위(명시한 `--project`가 있으면 그 범위)의 상태도 표시하며, 원격 실행은 불필요한 배포물 다운로드를 피하려고 선택한 대상의 상태만 확인한다. 미설치는 설치하고 오래된 설치는 갱신하며 최신 설치는 건너뛴다. 로컬 수정·관리 외 파일은 덮어쓸지 다시 묻고 기본값은 아니오다.

자동화에서는 동작과 [설치 위치 표](#기존-cli와-설치-위치)의 대상 ID를 모두 지정한다. 예를 들어 Gemini CLI·OpenCode·Cursor용 공유 위치는 `codex`, Cline 전용 위치는 `cline`이다.

```bash
curl -fsSL <ENGINE_URL>/skills/install.sh | sh -s -- install claude-code
curl -fsSL <ENGINE_URL>/skills/install.sh | sh -s -- install codex --project /path/to/project
curl -fsSL <ENGINE_URL>/skills/install.sh | sh -s -- status codex --project /path/to/project
curl -fsSL <ENGINE_URL>/skills/install.sh | sh -s -- update codex --project /path/to/project
```

POSIX `sh`, 기본 파일 도구, `awk`, `sha256sum` 또는 macOS의 `shasum -a 256`, `curl` 또는 `wget`이 필요하다. Git, Node.js, pnpm, Python과 엔진 빌드는 필요 없다. `wget -qO- <ENGINE_URL>/skills/install.sh | sh -s -- install codex`도 가능하다. 설치기는 MCP 설정·OAuth 로그인·Hermes 프로젝트 신뢰 승인을 수행하지 않고 별도 단계를 출력한다.

대화형 응답은 스크립트를 받는 표준 입력과 분리한 `/dev/tty`에서 읽는다. 제어 터미널이 없는 CI·컨테이너에서는 입력을 기다리지 않고 사용법을 출력하며 실패한다. `install`처럼 일부 인수만 지정하면 터미널에서 빠진 클라이언트·범위·디렉터리만 묻고, 명시한 값은 다시 묻지 않는다. 응답 중 EOF·Ctrl-C는 설치 파일을 쓰기 전에 중단한다.

`install`, `status`, `update`는 선택적인 `--project <dir>`, `--force`를 받는다. `--force`의 수정 보호 경계와 상태는 [기존 설치와 로컬 수정 보호](#기존-설치와-로컬-수정-보호)를 따른다. 다른 엔진에서 자료를 받으려면 파이프 오른쪽에 `LLMWIKI_URL=https://other.example.com sh -s -- install codex`를 지정한다. 이 변수는 다운로드 주소만 바꾸며 MCP 연결 주소를 저장하지 않는다.

공개 `GET /skills/install.sh`는 하나의 정본 `skills/install.sh`에 서버 설정 `PUBLIC_URL`의 끝 슬래시를 제거한 주소를 셸 인용해 넣는다. 요청의 `Host`·전달 헤더로 주소를 계산하지 않는다. 같은 스크립트가 복제본에서는 로컬 자료를, 표준 입력에서는 엔진 자료를 사용한다. `GET /skills/manifest/<client>`는 버전·설치 파일별 SHA-256을, `GET /skills/files/<sha256>`는 해당 배포 파일의 원본 바이트를 제공하며 `GET /skills/version.json`은 배포 버전 원본을 제공한다. 서버는 정본 `skills/llmwiki/`의 사용 안내만 시작 시 읽어 보관하므로 요청 경로로 저장소 파일을 탐색하지 않으며 경로 순회를 허용하지 않는다.

원격 설치는 모든 파일을 비공개 임시 디렉터리에 내려받고 각 SHA-256을 manifest와 대조한 뒤 기존 설치 보호 검사와 쓰기를 시작한다. 다운로드 실패·체크섬 불일치에서는 대상 파일과 설치 표식을 전혀 바꾸지 않는다. 원본 바이트를 그대로 내려받으므로 마지막 줄바꿈이 없는 파일·바이너리도 셸·CLI 설치와 동일하다. 스크립트와 manifest·파일 응답은 `Cache-Control: public, max-age=60`을 사용한다. 체크섬은 전송 일관성 검사이며 엔진 신뢰나 HTTPS를 대체하지 않는다.

### 저장소만으로 설치와 갱신
Skill만 사용할 때는 엔진 의존성 설치나 실행이 필요 없다. Git으로 저장소를 받은 뒤 POSIX `sh`와 기본 파일·SHA-256 도구로 설치한다. Node.js, pnpm, Python과 빌드는 필요 없다. 다음 명령은 저장소 상위 디렉터리에서 실행하며 마지막 인수는 [설치 위치 표](#기존-cli와-설치-위치)의 대상 ID로 바꾸어 사용한다.

```bash
git clone https://github.com/BitbyteCorp/llmwiki-engine.git \
  && sh llmwiki-engine/skills/install.sh install claude-code
```

비공개 저장소는 먼저 GitHub 접근 권한과 Git 인증을 준비한다. 이미 받은 저장소에서는 `git pull --ff-only`로 배포 자료를 갱신한 뒤 루트에서 다음 명령을 사용한다. `install`, `status`, `update`는 모두 설치 대상 ID, 선택적인 `--project <dir>`, `--force`를 받는다.

```bash
sh skills/install.sh
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

| 설치 대상 ID · 함께 읽는 에이전트 | 개인 설치 | `--project <dir>` 설치 |
|---|---|---|
| `claude-code` · Claude Code | `~/.claude/skills/llmwiki` | `<dir>/.claude/skills/llmwiki` |
| `codex` · Codex · Gemini CLI · OpenCode · Cursor · GitHub Copilot(VS Code/CLI) · Windsurf/Devin Desktop · Roo Code · Amp · Goose · Factory Droid · Zed · Crush | `~/.agents/skills/llmwiki` | `<dir>/.agents/skills/llmwiki` |
| `hermes` · Hermes | `~/.hermes/skills/llmwiki` | `<dir>/.hermes/skills/llmwiki` |
| `cline` · Cline | `~/.cline/skills/llmwiki` | `<dir>/.cline/skills/llmwiki` |
| `kiro` · Kiro | `~/.kiro/skills/llmwiki` | `<dir>/.kiro/skills/llmwiki` |
| `qwen-code` · Qwen Code | `~/.qwen/skills/llmwiki` | `<dir>/.qwen/skills/llmwiki` |

위치는 [Claude Code Skills](https://code.claude.com/docs/en/skills), [Codex Skills](https://developers.openai.com/codex/skills), [Hermes Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills#project-local-skills)의 클라이언트 규칙을 따른다. Hermes 프로젝트 대상은 `.git`이 있는 프로젝트 루트이며, 설치 후 사용자가 별도로 `hermes skills trust <dir>`를 실행해야 자동 로딩된다. 설치기는 프로젝트 신뢰 설정을 바꾸지 않는다. 한 클라이언트의 같은 이름을 여러 범위에 설치하면 우선순위에 따라 다른 복사본이 선택될 수 있으므로 의도한 범위의 상태를 확인한다.

#### 추가 대상의 포함 기준과 공식 Skill 위치
설치 대상은 공식 문서가 네이티브 `SKILL.md` 디렉터리를 명시한 경우만 추가한다. rules 파일이나 `AGENTS.md`·`CLAUDE.md`에 내용을 쓰지 않는다. 공통 원본의 필수 frontmatter는 `name: llmwiki`와 `description`이다. 같은 개인·프로젝트 공유 경로를 읽는 에이전트는 `codex` 대상 하나를 사용하며, 설치 표식의 소유자도 `codex`로 유지한다.

아래 경로는 공식 문서에 있는 탐색 루트이며 각 루트 아래 `llmwiki/SKILL.md`를 둔다. 이 설치기가 실제 선택한 위치는 위 표다. 필수 frontmatter는 모두 `name`·`description`이며 디렉터리 이름과 `name`을 일치시킨다.

| 에이전트 · 공식 문서 | 개인 / 프로젝트 네이티브 루트 | 호출 |
|---|---|---|
| [Gemini CLI](https://geminicli.com/docs/cli/skills/) · [형식](https://geminicli.com/docs/cli/creating-skills/) | `~/.gemini/skills` / `.gemini/skills`; 양쪽 `.agents/skills`도 지원한다. | 자동 `activate_skill`과 권한 승인; `/skills list`로 확인한다. |
| [OpenCode](https://opencode.ai/docs/skills) | `~/.config/opencode/skills` / `.opencode/skills`; 양쪽 `.agents/skills`·`.claude/skills`도 지원한다. | 자동 `skill` 도구다. `/llmwiki`는 별도 slash 메타데이터가 필요하므로 공통 원본에서 보장하지 않는다. |
| [Cursor](https://cursor.com/docs/skills) | `~/.cursor/skills` / `.cursor/skills`; 양쪽 `.agents/skills`·`.claude/skills`·`.codex/skills`도 지원한다. | 자동 또는 Agent 채팅의 `/` 메뉴다. |
| [GitHub Copilot · VS Code](https://code.visualstudio.com/docs/agent-customization/agent-skills) | `~/.copilot/skills`·`~/.agents/skills`·`~/.claude/skills` / `.github/skills`·`.agents/skills`·`.claude/skills`다. | 자동 또는 `/llmwiki`다. |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills) | `~/.copilot/skills`·`~/.agents/skills` / `.github/skills`·`.agents/skills`·`.claude/skills`다. | 자동 또는 `/llmwiki`; `/skills reload`로 다시 읽는다. |
| [Windsurf · Devin Desktop](https://docs.devin.ai/desktop/cascade/skills) | `~/.codeium/windsurf/skills`·`~/.config/devin/skills` / `.devin/skills`·구 `.windsurf/skills`; 양쪽 `.agents/skills`도 지원한다. | 자동 또는 `@llmwiki`다. |
| [Cline](https://docs.cline.bot/customization/skills) | `~/.cline/skills` / `.cline/skills`·`.clinerules/skills`·`.claude/skills`다. | 자동 또는 채팅의 `/` 메뉴다. |
| [Roo Code](https://roocodeinc.github.io/Roo-Code/features/skills/) | `~/.roo/skills` / `.roo/skills`; 양쪽 `.agents/skills`와 mode별 루트도 지원한다. | 설명에 따른 자동 선택과 `skill` 도구다. |
| [Kiro](https://kiro.dev/docs/skills.md) | `~/.kiro/skills` / `.kiro/skills`다. | 자동 또는 `/llmwiki`다. |
| [Amp](https://ampcode.com/docs/markdown/customize/skills) · [개인 위치](https://ampcode.com/docs/markdown/customize/global-plugins-and-skills) | `~/.agents/skills`·`~/.config/agents/skills` / `.agents/skills`; 양쪽 `.claude/skills`도 지원한다. | 설명에 따른 자동 선택이다. 공식 slash 호출은 명시되지 않는다. |
| [Goose](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/context-engineering/using-skills.md) | `~/.agents/skills` / `.agents/skills`; 구 `.goose/skills`·`.claude/skills`도 탐색한다. | 자동 또는 CLI의 `/skills llmwiki`다. |
| [Factory Droid](https://docs.factory.com/harness/skills) | `~/.factory/skills` / `.factory/skills`; 양쪽 `.agents/skills`도 지원한다. | 자동 또는 `/llmwiki`; `/skills`에서 관리한다. |
| [Zed](https://zed.dev/docs/ai/skills) | `~/.agents/skills` / `.agents/skills`다. | 자동 또는 `/llmwiki`·`@skill`이다. |
| [Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/users/features/skills/) | `~/.qwen/skills` / `.qwen/skills`다. | 자동 또는 `/llmwiki`; `/skills`에서 관리한다. |
| [Crush](https://github.com/charmbracelet/crush/blob/main/internal/skills/builtin/crush-config/SKILL.md) | `~/.agents/skills`·`~/.config/agents/skills`·`~/.config/crush/skills`·`~/.claude/skills` / `.agents/skills`·`.crush/skills`·`.claude/skills`·`.cursor/skills`다. | 자동 선택이다. `user:llmwiki`·`project:llmwiki` 직접 호출은 `user-invocable: true`가 필요하므로 공통 원본에서 보장하지 않는다. |

Continue는 [공식 문서](https://docs.continue.dev/)에서 네이티브 Skill 디렉터리·형식을 확인하지 못해 설치 대상에서 제외한다. 문서가 없는 것은 기능이 절대 없다는 뜻이 아니라 이 설치기의 지원 근거가 없다는 뜻이다.


셸·CLI 설치 디렉터리에는 다음 두 파일만 둔다.

- `SKILL.md`는 [`skills/llmwiki/SKILL.md`](../skills/llmwiki/SKILL.md)의 공통 원본을 복사한 파일이다. 저장소에서는 클라이언트별 프롬프트 복제본을 유지하지 않는다.
- `.llmwiki-install.json`은 설치기 스키마, 클라이언트, 설치 버전, 관리 파일별 SHA-256을 기록한다. 비밀값이나 OAuth 토큰을 기록하지 않는다.

Skill은 에이전트가 실행 중 문맥으로 불러오는 MCP 도구 사용 안내다. 설치·연결 문서를 함께 넣으면 매 작업의 문맥을 낭비하고 클라이언트 설정 변경에 따라 오래된 안내가 남는다. 따라서 클라이언트별 설치·MCP 설정·OAuth 절차와 인라인 설정 예시는 이 문서와 llmwiki 설정의 MCP 탭에서만 제공하며, 설치 디렉터리에는 복사하지 않는다.

정본 사용 안내의 배포 버전은 `skills/version.json`에서 관리한다. 사용 안내나 배포 파일 구성이 바뀌면 버전을 올리며, 설치 대상이 아닌 설치기 자체만 바뀌면 배포 버전은 유지한다. Claude 플러그인의 `skills/.claude-plugin/plugin.json`의 `version`과 마켓플레이스의 `.claude-plugin/marketplace.json`의 `metadata.version`도 같은 값으로 갱신한다. 호스팅한 Claude 플러그인은 manifest 버전으로 캐시를 갱신하므로 내용만 바꾸고 버전을 유지하지 않는다.

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

`--force`는 엔진 환경 설정, `~/.codex/config.toml`, `~/.hermes/config.yaml`, 프로젝트의 활성 `.mcp.json`, OAuth 저장소를 덮어쓰는 옵션이 아니다. 이전 배포에서 설치한 클라이언트별 안내도 기존 표식이 관리하던 파일만 제거하며, 로컬 수정이 있으면 같은 보호 규칙을 적용한다.

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

정확한 원본은 `skills/llmwiki`다. [OpenAI 공식 skill-installer 지침](https://github.com/openai/skills/blob/main/skills/.system/skill-installer/SKILL.md)은 `install-skill-from-github.py --repo BitbyteCorp/llmwiki-engine --path skills/llmwiki` 또는 같은 `tree/main/skills/llmwiki` URL을 지원한다. 이 명령은 설치기가 가진 Python 도우미의 인자이며 존재하지 않는 `codex skills install` 명령이 아니다. 도우미 기본 설치 위치는 `$CODEX_HOME/skills`이고 기본값은 `~/.codex/skills`다. 저장소 전용 셸·CLI의 `~/.agents/skills`와 구분하며, 설치 결과를 원하는 범위에 맞출 때는 공식 도우미의 `--dest`를 사용한다. Python 없이 설치하려면 저장소 전용 셸 경로를 사용한다. 새 Skill이 보이지 않으면 Codex를 다시 시작한다.

#### Hermes GitHub Skill 설치
[공식 Hermes Skills의 직접 GitHub 설치](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills#installing-individual-skills-directly-without-adding-a-tap)는 `owner/repo/skills/skill-name`을 지원한다.

```bash
hermes skills install BitbyteCorp/llmwiki-engine/skills/llmwiki
```

[공식 지원 소스 표](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills#supported-hub-sources)의 `github` 소스를 사용하며, 정본 디렉터리를 지정한다. 공개 저장소의 개별 경로는 tap 추가 없이 설치할 수 있다. 공식 문서는 비공개 GitHub tap에 `GITHUB_TOKEN`이 필요하다고 설명하지만 비공개 개별 경로의 직접 설치까지 보장하지는 않으므로, 비공개 저장소는 Git 인증으로 복제한 뒤 저장소 전용 셸 설치기를 사용한다. Hermes 설치기의 보안 검사·설치 확인·갱신 정책을 따르며 셸 설치기의 `--force`와 혼동하지 않는다. 새 세션의 `/llmwiki`로 호출한다.


### 공통 지식 활용 프롬프트
공통 프롬프트는 영어로 작성하며 도니가 지식 노트를 쓰는 한국어 규칙과 구분한다. 설명문은 지식 질문뿐 아니라 팀 프로젝트·제품의 모든 작업 시작, 낯선 제품·기능·용어·약어, 설계·정책·제품 결정, 오류 해결, 문구·공지·명세·캠페인 작성, 지표·이벤트 분석, 사용자에게 물을 내용 확인과 작업 후 교훈 기록에서 자동 로딩되도록 작성한다.

작업 시작에는 서버 지침의 위키 지도로 도메인과 허브를 고른다. 지도가 없으면 인자 없이 `list_notes()`를 한 번 호출해 루트 색인과 읽을 수 있는 파일 목록을 확인한다. 코드 작업은 제품·저장소와 구성 요소, 오류는 메시지와 증상, 글쓰기는 제품별 작성 지침, 분석은 이벤트 사전·측정 기록, 계획은 결정·로드맵·이전 실험, 낯선 용어는 공유 개념·엔티티부터 조회한다. 새 고유명사가 나타나거나 가정을 확정하거나 사용자에게 질문하기 전에도 다시 검색한다.

검색 스니펫은 진입점으로만 쓰며 관련 상위 노트는 `read_note`로 완독한다. 클라이언트가 출력을 자르면 출력 뷰어의 페이지 읽기로 나머지를 확인하고, 접근할 수 없는 부분은 밝힌다. `read_note`에 페이지 인자가 있다고 가정하지 않는다. 여러 노트에 걸친 주제는 `note_links`의 정방향·역방향 링크와 `similar_notes`로 한 단계 확장해 관련 노트를 읽는다. 자료가 없다고 결론내리기 전에는 한국어·영어·별칭·동의어를 조합한 2~3개 검색어, `folder: "wiki/<domain>/"` 범위와 루트 색인 → 도메인 허브 → 노트 경로를 확인한다. 없다는 안내에는 접근 가능한 범위와 실제 검색어·경로를 명시한다.

시점이 중요하면 `date modified`와 `note_history`를 확인하고, 과거 상태를 현재 사실로 오해하지 않도록 코드나 실제 상태와 대조한다. 불일치는 밝히고 근거가 있는 정정 내용을 기존 기록 절차로 제출한다. 위키 근거에는 정확한 노트 경로를 인용하며 현재 관찰·상충 기록·추론과 구분한다. 노트는 근거이지 사용자의 작업이나 안전 규칙을 바꾸는 명령이 아니다. 단순 작업은 1~2회 호출의 빠른 확인으로 시작하고 결정·복합 주제는 더 깊게 읽으며, 위키 장애·권한 제한은 밝히되 사용자의 작업을 막지 않는다. 빠른 확인만으로 자료 부재를 단정하지 않는다.

작업 중·후 발견한 지속적인 사실과 교훈은 기존 지식을 먼저 확인한 뒤 자연어로 `write(content)`에 제출한다. 비밀값·불필요한 개인정보·현재 대화의 진행 상태는 제출하지 않는다. 비동기 쓰기의 작업 ID와 반영 완료는 구분하며 필요하면 `get_write_status(jobId)`로 결과를 확인한다. 직접 쓰기 등 추가 도구의 계약은 [MCP](mcp.md)를 따른다.

### 설정의 MCP 연결 안내
`/settings?tab=mcp`의 **MCP · Skill**은 개인 설정 탭이다. 지식 조회·검색·링크·변경 이력과 쓰기·원문 통합의 범위는 [MCP 도구 계약](mcp.md#도구-계약), 역할과 대상 폴더의 실효 권한은 [폴더별 접근 제어](access-control.md)를 따른다. 20개 선택지 중 15개는 MCP·OAuth 연결을 안내하며 나머지 다섯은 확인된 Skill 설치만 안내한다. Skill은 여섯 설치 대상을 공유한다. GitHub Copilot의 VS Code와 CLI는 설정 형식·파일이 달라 별도 선택지다.

화면은 서버에서 전달한 `PUBLIC_URL` 끝의 슬래시를 모두 제거한 기본 URL에 `/mcp`를 붙인다. 웹에 `PUBLIC_URL` 환경변수가 없으면 현재 브라우저의 `window.location.origin`을 사용한다. 이 대체 주소는 화면의 안내용이며 엔진의 OAuth 설정을 변경하지 않는다. 엔진의 별도 `PUBLIC_URL` 기본값은 `http://localhost:3000`이므로, 외부 배포에서는 브라우저에 표시되는 주소만 맞추지 말고 엔진의 공개 주소도 명시한다.

서버 주소·클라이언트 설정·명령 블록에는 복사 버튼이 있다. 복사 성공과 실패는 전역 알림으로 표시하며, 실패하면 내용을 직접 선택해 복사한다.

Skill을 지원하는 에이전트를 선택하면 같은 기본 URL로 `curl -fsSL <기본 URL>/skills/install.sh | sh -s -- install <대상 ID>` 명령을 제공한다. 공유 위치를 읽는 에이전트는 자기 이름을 선택하더라도 `install codex`와 공유 위치 설명을 표시한다. `| sh`까지만 실행하면 대화형으로 선택한다. macOS·Linux에서 저장소 복제나 `llmwiki` CLI 설치 없이 Skill을 설치하며, 명령 끝에 `--project /path/to/project`를 붙이면 프로젝트 범위를 선택한다. 설치는 MCP 연결·OAuth 로그인을 수행하지 않으므로 연결 등록과 로그인 단계를 별도로 완료한다. OAuth 절차가 확인되지 않은 에이전트는 Skill만 안내하며 연결 가능하다고 단정하지 않는다.

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

Claude Code에서 `/mcp`를 열어 브라우저 OAuth 인증을 완료한다. 새 세션에서 셸·CLI 설치는 `/llmwiki`, 마켓플레이스 설치는 `/llmwiki:llmwiki`로 호출한다. 플러그인은 MCP 서버를 자동 등록하지 않으며 임시 플러그인이나 `LLMWIKI_URL` 환경변수 설정도 필요 없다.

#### Codex
[공식 MCP 문서](https://developers.openai.com/codex/mcp)에 따라 기존 `~/.codex/config.toml` 또는 신뢰한 프로젝트의 `.codex/config.toml`에 다음 테이블을 병합한다.

```toml
[mcp_servers.llmwiki]
url = "https://wiki.example.com/mcp"
```

`codex mcp login llmwiki`로 브라우저 OAuth 로그인을 완료한다. 새 세션의 `/mcp`로 연결을 확인하고 `/skills` 또는 `$llmwiki`로 Skill을 호출한다.

#### Hermes
[공식 MCP 문서](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)에 따라 기존 `~/.hermes/config.yaml`의 `mcp_servers`에 다음 `llmwiki` 항목을 병합한다.

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

설정 안내가 사용하는 Cursor 형식은 `url`이며 `type` 필드를 추가하지 않는다. Customize의 MCP 도구 화면에서 연결하고 브라우저 OAuth 인증을 완료한다. [공식 CLI MCP 명령](https://cursor.com/docs/cli/mcp)의 `agent mcp login llmwiki`도 같은 설정의 서버에 로그인한다.

#### GitHub Copilot · VS Code
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

#### Gemini CLI
[공식 MCP 문서](https://geminicli.com/docs/tools/mcp-server)와 [설정 위치](https://geminicli.com/docs/reference/configuration/)에 따라 개인 `~/.gemini/settings.json` 또는 프로젝트 `.gemini/settings.json`의 `mcpServers`에 병합한다.

```json
{
  "mcpServers": {
    "llmwiki": { "httpUrl": "https://wiki.example.com/mcp" }
  }
}
```

Streamable HTTP에는 `url`이 아니라 `httpUrl`을 사용한다. Gemini CLI 안에서 `/mcp auth llmwiki`로 브라우저 OAuth 로그인을 완료한다. Skill은 `install codex`로 공유 위치에 설치하며 `/skills list`로 확인하고 관련 요청에서 자동 활성화와 권한 승인을 따른다. Gemini CLI의 무료·Google One 사용자는 공식 문서의 Antigravity CLI 전환 안내를 확인하며 다른 제품의 설정을 그대로 적용하지 않는다.

#### OpenCode
[공식 MCP 문서](https://opencode.ai/docs/mcp-servers)와 [설정 문서](https://opencode.ai/docs/config)에 따라 개인 `~/.config/opencode/opencode.json` 또는 프로젝트 `opencode.json`에 병합한다.

```json
{
  "mcp": {
    "llmwiki": { "type": "remote", "url": "https://wiki.example.com/mcp" }
  }
}
```

`opencode mcp auth llmwiki`로 브라우저 OAuth 로그인을 완료하고 `opencode mcp list`로 확인한다. OAuth는 자동 발견하며 `oauth: false`로 끄지 않는다. Skill은 `install codex`로 공유 위치에 설치하며 에이전트의 `skill` 도구가 필요할 때 로드한다. 공통 원본에는 OpenCode 전용 slash 메타데이터가 없으므로 `/llmwiki` 명령이 생긴다고 가정하지 않는다.

#### GitHub Copilot CLI
[공식 MCP 설정 문서](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)에 따라 개인 `~/.copilot/mcp-config.json` 또는 프로젝트 `.mcp.json`·`.github/mcp.json`에 병합한다. Copilot CLI는 VS Code의 `.vscode/mcp.json`을 읽지 않는다.

```json
{
  "mcpServers": {
    "llmwiki": {
      "type": "http",
      "url": "https://wiki.example.com/mcp",
      "tools": ["*"]
    }
  }
}
```

Copilot CLI 안에서 `/mcp auth llmwiki`로 브라우저 OAuth 로그인을 완료한다. `copilot login`은 GitHub 계정 로그인이지 MCP 서버 인증 명령이 아니다. Skill은 `install codex`로 공유 위치에 설치하고 `/llmwiki` 또는 설명에 맞는 자동 선택을 사용한다.

#### Cline
[공식 MCP 문서](https://docs.cline.bot/mcp/mcp-overview)에 따라 Cline CLI의 `~/.cline/data/settings/cline_mcp_settings.json`에 병합한다. `CLINE_MCP_SETTINGS_PATH`로 경로를 바꿀 수 있다. 확장 프로그램은 **MCP Servers → Configure → Configure MCP Servers**에서 별도 JSON을 열며 CLI와 같은 설정·인증 저장소라고 가정하지 않는다. 아래 OAuth 로그인은 공식 문서가 명시한 CLI 절차다.

```json
{
  "mcpServers": {
    "llmwiki": { "type": "streamableHttp", "url": "https://wiki.example.com/mcp" }
  }
}
```

`cline mcp`의 서버 메뉴에서 **Authorize OAuth**를 선택하고 브라우저 인증을 완료한다. Skill은 `install cline`으로 설치하며 새 세션에서 자동 활성화하거나 `/` 메뉴에서 선택한다.

#### Kiro
[공식 MCP 설정 문서](https://kiro.dev/docs/mcp/configuration.md)에 따라 개인 `~/.kiro/settings/mcp.json` 또는 프로젝트 `.kiro/settings/mcp.json`에 병합한다.

```json
{
  "mcpServers": {
    "llmwiki": { "url": "https://wiki.example.com/mcp" }
  }
}
```

Streamable HTTP와 OAuth를 지원하며 DCR을 지원하는 서버에 연결하면 브라우저 인증 페이지를 연다. [공식 slash 참조](https://kiro.dev/docs/reference/slash-commands.md#mcp-auth)의 `/mcp auth llmwiki`로 다시 인증한다. Skill은 `install kiro`로 설치하고 자동 선택 또는 `/llmwiki`로 호출한다.

#### Amp
[공식 MCP 문서](https://ampcode.com/docs/markdown/customize/mcp)는 기본 Streamable HTTP와 SSE 대체 전송, 원격 OAuth를 설명한다. 로컬 설정 위치는 개인 `~/.config/amp/settings.json` 또는 프로젝트 `.amp/settings.json`이며 형식은 다음과 같다.

```json
{
  "amp.mcpServers": {
    "llmwiki": { "url": "https://wiki.example.com/mcp" }
  }
}
```

설정 화면의 안내는 로그인 명령까지 명시된 **호스팅 개인 원격 정의** 경로를 사용한다. 이 경우 로컬 JSON을 중복 추가하지 않고 아래 두 명령을 함께 실행한다.

```bash
amp mcp remote add llmwiki https://wiki.example.com/mcp --auth oauth --personal
amp mcp remote --personal login llmwiki
```

로컬 설정과 호스팅 정의는 다른 저장 위치이므로 두 경로의 로그인 명령을 혼합하지 않는다. Skill은 `install codex`로 공유 위치에 설치하고 설명에 따른 자동 선택을 사용한다.

#### Factory Droid
[공식 MCP 문서](https://docs.factory.com/harness/mcp)에 따라 개인 `~/.factory/mcp.json` 또는 프로젝트 `.factory/mcp.json`에 병합한다.

```json
{
  "mcpServers": {
    "llmwiki": { "type": "http", "url": "https://wiki.example.com/mcp" }
  }
}
```

`http`는 Streamable HTTP다. `droid mcp add llmwiki https://wiki.example.com/mcp --type http`로 등록할 수도 있으며 두 방법을 중복 적용하지 않는다. `/mcp`에서 서버를 선택하고 브라우저 인증을 완료한다. Skill은 `install codex`로 공유 위치에 설치하고 자동 선택 또는 `/llmwiki`로 호출한다.

#### Qwen Code
[공식 MCP 사용자 문서](https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/)에 따라 개인 `~/.qwen/settings.json` 또는 프로젝트 `.qwen/settings.json`에 병합한다.

```json
{
  "mcpServers": {
    "llmwiki": { "httpUrl": "https://wiki.example.com/mcp" }
  }
}
```

`qwen mcp add --transport http llmwiki https://wiki.example.com/mcp`로 등록할 수도 있다. [공식 OAuth 안내](https://qwenlm.github.io/qwen-code-docs/en/developers/tools/mcp-server/#oauth-support-for-remote-mcp-servers)에 따라 인증 요구를 감지하고 발견·DCR·브라우저 로그인을 수행한다. `/mcp` 패널에서 서버와 인증을 관리하며 문서에 없는 `qwen mcp login` 명령을 사용하지 않는다. Skill은 `install qwen-code`로 설치하고 자동 선택 또는 `/llmwiki`로 호출한다.

#### MCP 안내에서 제외한 대상
원격 Streamable HTTP와 OAuth 설정·로그인 절차를 공식 문서로 확인한 경우만 단계별 연결을 안내한다. 아래 대상은 확인된 Skill 설치만 제공하거나 전체 대상에서 제외한다. 제외는 기능 부재의 단정이 아니다.

| 대상 · 공식 근거 | 제외 이유 |
|---|---|
| [Windsurf · Devin Desktop](https://docs.devin.ai/desktop/cascade/mcp) | 구 Cascade 문서는 HTTP·OAuth 지원을 명시하지만 정확한 OAuth 로그인 동작이 없다. 기본 Devin Local과 설정 위치도 달라 다른 제품의 명령으로 대체하지 않는다. Skill만 안내한다. |
| [Roo Code](https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo) | Streamable HTTP 설정은 있으나 OAuth 로그인 절차가 명시되지 않는다. Skill만 안내한다. |
| [Goose](https://github.com/aaif-goose/goose/blob/main/documentation/docs/getting-started/using-extensions.md) | `~/.config/goose/config.yaml`의 `extensions.llmwiki` 아래 `type: streamable_http`, `uri`, `enabled: true`와 OAuth 자동 클라이언트 등록은 문서화되어 있다. 그러나 브라우저 인증 시작 동작이나 별도 login 명령을 확인하지 못해 `goose configure`를 로그인 명령으로 제시하지 않는다. Skill만 안내한다. |
| [Zed](https://zed.dev/docs/ai/mcp) | `~/.config/zed/settings.json`의 `context_servers.llmwiki.url`과 브라우저 OAuth는 있으나 이 원격 전송이 Streamable HTTP라고 명시되지 않는다. Skill만 안내한다. |
| [Crush](https://github.com/charmbracelet/crush/blob/main/docs/config/README.md) | `~/.config/crush/crushrc` 또는 프로젝트 `.crushrc`의 `mcp add llmwiki --type http --url URL --oauth true`는 문서화되어 있으나 Streamable HTTP 명시와 별도 로그인 절차를 확인하지 못했다. Skill만 안내한다. |
| [Continue](https://docs.continue.dev/customize/deep-dives/mcp) | `.continue/mcpServers/<name>.yaml`의 `type: streamable-http` 설정은 있으나 OAuth 설정·로그인 절차와 네이티브 Skill 디렉터리를 확인하지 못해 두 안내 모두 제외한다. |

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
