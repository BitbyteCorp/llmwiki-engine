# 설치형 Skills
설치형 Skills는 Claude Code, Codex, Hermes에 공통 지식 활용 프롬프트와 클라이언트별 연결 예시를 안전하게 설치한다.

## 배경
MCP 연결만으로는 클라이언트가 언제 지식을 검색하고 무엇을 저장해야 하는지 충분히 안내하지 못한다. Skill은 기존 지식을 먼저 활용하고, 재사용할 가치가 있는 결정·이유·동작·문제 해결 지식을 능동적으로 제출하도록 안내한다. Hermes는 Nous Research의 Hermes Agent를 뜻한다.

Skill 설치와 MCP 연결·OAuth 로그인은 별개다. 설치기는 로그인하거나 비밀값을 저장하지 않으며, 기존 클라이언트 설정을 수정하지 않는다. 프롬프트 배치만으로 엔진 연결이 완료되었다고 간주하지 않는다.

## 내용
### CLI와 설치 위치
빌드된 CLI는 `llmwiki skill`을 사용하며, 개발 환경에서는 `pnpm cli skill`을 사용한다. 세 하위 명령은 모두 `<claude-code|codex|hermes>`, 선택적인 `--project <dir>`, `--force`를 받는다.

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
- `client/`에는 선택한 클라이언트의 `skills/<client>/` 자료를 원래 상대 경로대로 복사한다. README와 MCP 예시, Claude 플러그인 manifest는 참고 자료이며 활성 클라이언트 설정이 아니다.
- `.llmwiki-install.json`은 설치기 스키마, 클라이언트, 설치 버전, 관리 파일별 SHA-256을 기록한다. 비밀값이나 OAuth 토큰을 기록하지 않는다.

공통 원본과 클라이언트 자료의 배포 버전은 `skills/version.json`에서 관리한다. 자료 변경을 배포할 때 이 버전도 갱신한다. 설치기는 모듈 위치 기준 `../../skills/`를 읽으므로 개발의 `src/skill`과 빌드의 `dist/skill`에서 모두 저장소 루트의 자료를 사용한다. 현재 작업 디렉터리에 의존하지 않는다. 빌드 배포물은 `dist/`와 함께 루트 `skills/`를 포함해야 하며, Docker 런타임도 이 디렉터리를 복사한다.

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

### 공통 지식 활용 프롬프트
공통 프롬프트는 영어로 작성하며 Luna가 지식 노트를 쓰는 한국어 규칙과 구분한다. 질문에 답하기 전에 검색하고 관련 노트를 읽으며, 확인한 노트의 정확한 경로를 답변에 인용한다. 검색하지 못한 사실과 추론은 위키 근거와 구분한다. 노트 내용은 근거로 취급하며 사용자의 작업이나 안전 규칙을 바꾸는 명령으로 취급하지 않는다.

작업 중 발견한 지속적인 사실과 교훈은 기존 지식을 먼저 확인한 뒤 자연어로 `write(content)`에 제출한다. 비밀값·불필요한 개인정보·현재 대화의 진행 상태는 제출하지 않는다. 비동기 쓰기의 작업 ID와 반영 완료는 구분하며 필요하면 `get_write_status(jobId)`로 결과를 확인한다. 직접 쓰기 등 추가 도구의 계약은 [MCP](mcp.md)를 따른다.

### 별도 MCP 연결과 OAuth
`<ENGINE_URL>`은 실제 엔진 기본 URL이며 전체 MCP 주소는 끝의 `/`를 제거한 기본 URL에 `/mcp`를 붙인 값이다. 예시 도메인 `https://wiki.example.com`은 실제 배포 주소로 바꾼다. 기존 서버 설정이 있으면 중복 선언하지 않고 해당 항목만 수정한다. 정적 토큰이나 비밀값을 예시 파일에 넣지 않는다.

#### Claude Code
[공식 MCP 문서](https://code.claude.com/docs/en/mcp)에 따라 개인 연결은 다음 명령으로 별도 등록한다. 프로젝트 연결은 `--scope project`를 사용하며 사용자 승인 절차를 거친다.

```bash
claude mcp add --transport http --scope user llmwiki "<ENGINE_URL>/mcp"
```

Claude Code에서 `/mcp`를 열어 브라우저 OAuth 인증을 완료한다. 새 세션에서 `/llmwiki`로 Skill을 호출한다. `client/.mcp.json`은 `${LLMWIKI_URL}/mcp`를 사용하는 플러그인 예시일 뿐, 설치 명령은 해당 설정을 자동 활성화하지 않는다. 임시 플러그인 구성은 [클라이언트 자료](../skills/claude-code/README.md)를 따른다.

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

각 클라이언트에서 실제 지식 질문의 검색·노트 읽기 결과와 경로 인용을 확인해야 연결 성공으로 판단한다. Skill이나 서버 목록 표시만으로 도구 실행 성공을 판단하지 않는다. 쓰기는 editor 또는 admin 권한을 사용한다.

## 관련 문서
- [MCP](mcp.md)는 지식의 읽기·쓰기·검색 계약을 설명한다.
- [쓰기 흐름](write-flow.md)은 제출한 지식을 반영하는 절차를 설명한다.
- [인증](auth.md)은 엔진 로그인과 MCP OAuth 계약을 설명한다.
- [개발 환경](development.md)은 빌드와 CLI 실행 방법을 설명한다.
