# 설치형 Skills
설치형 Skills는 Claude Code, Codex, Hermes에 엔진의 MCP 연결 설정과 지식 활용 프롬프트를 제공한다.

## 배경
MCP 연결만으로는 클라이언트가 언제 지식을 검색하고 무엇을 저장해야 하는지 충분히 안내하지 못한다. 설치형 Skills는 사용자가 명시적으로 저장을 요청하지 않아도 가치 있는 지식을 능동적으로 저장하도록 유도하고, 기존 지식을 먼저 활용하도록 안내한다.

대상은 Claude Code, Codex, Hermes이며, Hermes는 Nous Research의 Hermes Agent를 뜻한다. 아래는 각 클라이언트의 공식 문서로 확인한 설치·연결 방식이며, 엔진의 실제 배포 패키지나 설치 명령이 확정되었다는 뜻은 아니다.

## 내용
### 공통 구성과 사용 프롬프트
설치형 Skill의 구성은 `SKILL.md` 기반 사용 프롬프트와 클라이언트별 MCP 연결 설정이다. Skill 설치와 MCP 연결·OAuth 로그인은 구분하며, 프롬프트 파일을 배치하는 것만으로 연결이나 로그인이 끝났다고 간주하지 않는다.

프롬프트에는 다음 행동을 담는다.

- 세션 시작 시 MCP로 메모리 파일을 먼저 읽고 현재 공유 문맥을 파악한다.
- 지식에 관한 답변을 만들기 전에 지식 저장소를 검색하고 관련 노트를 읽어 근거를 확보한다.
- 사용자의 명시적 저장 요청이 없어도 재사용할 가치가 있는 사실, 결정과 이유, 문제 해결 과정 등을 판단해 능동적으로 저장한다.
- 저장할 때는 자연어 지시나 원문을 MCP로 제출하며, 클라이언트가 지식 저장소의 파일 배치와 직접 편집을 맡지 않는다.

예를 들어 대화에서 반복되는 장애의 원인과 해결 방법을 알아냈다면, 기존 노트를 검색한 뒤 해당 지식을 보완할 자연어 지시와 원문을 제출한다. Luna가 지식을 반영하는 절차는 [쓰기 흐름](write-flow.md)을 따르며, 메모리 파일의 노출 방식과 도구 계약은 [MCP](mcp.md)를 따른다. 로그인과 접근 제어는 [인증](auth.md)을 따른다.

`SKILL.md`의 설명에는 지식 질문, 세션 문맥 확인, 가치 있는 지식 발견이라는 사용 조건을 드러낸다. 다만 Claude Code와 Codex는 관련성에 따라 Skill을 선택하고 Hermes도 본문을 필요할 때 읽으므로, 설치만으로 모든 세션 시작 시 본문 실행이 보장되지는 않는다는 점은 각 [Claude Code Skills 문서](https://code.claude.com/docs/en/skills), [Codex Skills 문서](https://developers.openai.com/codex/skills), [Hermes Skills 가이드](https://hermes-agent.nousresearch.com/docs/guides/work-with-skills)에서 확인된다.

### Claude Code
#### Skill 설치
[공식 Skills 문서](https://code.claude.com/docs/en/skills)에 따라 개인용 Skill은 `~/.claude/skills/<skill-name>/SKILL.md`에, 프로젝트용 Skill은 `.claude/skills/<skill-name>/SKILL.md`에 배치한다. `SKILL.md`에는 YAML frontmatter와 본문을 두며, `description`은 자동 선택 조건을 설명하고 `name`을 지정하면 호출 이름에 사용된다. 관련 요청에서 자동으로 선택되거나 `/<skill-name>`으로 직접 호출한다.

연결 설정까지 묶어 배포하려면 플러그인을 사용할 수 있다. [공식 플러그인 명세](https://code.claude.com/docs/en/plugins-reference)에 따라 플러그인 루트의 `skills/<skill-name>/SKILL.md`와 `.mcp.json`을 함께 제공하거나, `.claude-plugin/plugin.json`의 `mcpServers`에 연결 설정을 선언한다. [공식 설치 안내](https://code.claude.com/docs/en/plugins/install)에 따라 배포자가 제공한 marketplace를 추가한 뒤 `/plugin install <plugin-name>@<marketplace-name>`으로 상세 화면을 열고 설치 범위를 선택한다. 이 엔진의 플러그인 이름과 marketplace는 아직 지정되지 않았다.

#### 원격 HTTP MCP와 OAuth
[공식 MCP 문서](https://code.claude.com/docs/en/mcp)에 따라 원격 서버는 `--transport http`로 등록하며, 개인의 모든 프로젝트에 적용하려면 `--scope user`를 사용한다. 다음 명령의 `<MCP_SERVER_NAME>`과 `<ENGINE_MCP_URL>`은 배포자가 제공한 실제 이름과 전체 URL로 바꿔야 하는 자리표시자다.

```bash
claude mcp add --transport http --scope user "<MCP_SERVER_NAME>" "<ENGINE_MCP_URL>"
```

Claude Code 안에서 `/mcp`를 열어 해당 서버의 인증 절차를 시작하고 브라우저 로그인을 완료한다. OAuth는 HTTP 서버에서 지원되며, 토큰은 저장되고 자동 갱신된다는 점은 [공식 OAuth 안내](https://code.claude.com/docs/en/mcp#authenticate-with-remote-mcp-servers)에 명시되어 있다. 연결 상태는 `/mcp`에서 확인한다. 프로젝트에 연결 설정을 공유하는 방식은 `--scope project`이며, `.mcp.json`의 서버는 사용자의 승인 절차를 거친다는 점은 [공식 범위 안내](https://code.claude.com/docs/en/mcp#project-scope)에 명시되어 있다.

### Codex
#### Skill 설치
[공식 Skills 문서](https://developers.openai.com/codex/skills)에 따라 개인용 Skill 디렉터리는 `$HOME/.agents/skills`에 배치하고, 프로젝트용 Skill은 `.agents/skills`에 배치한다. Codex는 현재 작업 디렉터리부터 저장소 루트까지 각 디렉터리의 `.agents/skills`를 탐색한다. 각 Skill 디렉터리의 `SKILL.md`에는 `name`과 `description`을 포함한다. `/skills` 또는 `$`로 명시적으로 선택하거나, 설명과 요청이 일치할 때 자동으로 선택된다.

외부 저장소에서 가져올 때는 공식 내장 `$skill-installer`에 배포자가 제공한 저장소와 Skill 위치를 전달할 수 있다. 선택 사항인 `agents/openai.yaml`에는 MCP 의존성을 선언할 수 있지만, 실제 서버 연결 설정과 OAuth 로그인은 아래의 MCP 절차로 구분한다. 이러한 설치기와 메타데이터 형식은 [공식 Skills 문서](https://developers.openai.com/codex/skills)에 설명되어 있다.

#### 원격 HTTP MCP와 OAuth
[공식 MCP 문서](https://developers.openai.com/codex/mcp)에 따라 개인 설정은 `~/.codex/config.toml`에 기록하며, 신뢰한 프로젝트에서는 `.codex/config.toml`에 프로젝트별 설정을 둘 수 있다. 원격 Streamable HTTP 서버는 `[mcp_servers.<server-name>]` 테이블의 `url`로 지정하며 OAuth, CIMD, DCR을 지원한다. 다음 설정의 자리표시자는 배포자가 제공한 값으로 바꾼다.

```toml
[mcp_servers."<MCP_SERVER_NAME>"]
url = "<ENGINE_MCP_URL>"
```

[공식 CLI 안내](https://developers.openai.com/codex/mcp)에 따라 다음 명령으로 해당 서버의 OAuth 로그인을 시작하고 브라우저에서 인증을 완료한다. Codex TUI의 `/mcp`에서 활성 서버를 확인한다.

```bash
codex mcp login "<MCP_SERVER_NAME>"
```

### Hermes
#### Skill 설치
[공식 Skills 문서](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)에 따라 기본 Skill 위치는 `~/.hermes/skills/`이며, `SKILL.md`는 `name`, `description` 등의 YAML frontmatter와 본문을 가진다. 배포자가 제공한 Skill 디렉터리를 이 위치에 배치하거나, Skills Hub 설치기로 공개 GitHub 저장소의 Skill 경로 또는 HTTP(S)의 `SKILL.md` URL에서 설치할 수 있다. GitHub 경로 설치와 URL 설치는 각각 [공식 GitHub 설치 안내](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills#4-direct-github-skills-github)와 [공식 Hub 안내](https://hermes-agent.nousresearch.com/docs/guides/work-with-skills#installing-from-the-hub)에 설명되어 있다.

다음 명령의 `<PUBLISHED_SKILL_MD_URL>`은 엔진의 가상 URL이 아니라 배포자가 실제로 제공해야 하는 `SKILL.md` URL의 자리표시자다.

```bash
hermes skills install "<PUBLISHED_SKILL_MD_URL>"
hermes skills list
```

설치한 Skill은 `/<skill-name>`으로 호출하며, 새 설치는 새 세션에 적용된다는 점은 [공식 사용 가이드](https://hermes-agent.nousresearch.com/docs/guides/work-with-skills)에 명시되어 있다.

#### 원격 HTTP MCP와 OAuth
[공식 MCP 문서](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)와 [공식 저장소의 MCP 원문](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md)에 따라 `~/.hermes/config.yaml`의 `mcp_servers` 아래에 `url`과 `auth: oauth`를 기록한다. Hermes는 OAuth 2.1의 디스커버리, 클라이언트 식별, PKCE, 토큰 교환과 갱신을 처리하며, 지원 서버에는 CIMD를 사용하고 그렇지 않으면 DCR로 전환한다. 다음 설정의 자리표시자는 배포자가 제공한 값으로 바꾼다.

```yaml
mcp_servers:
  <MCP_SERVER_NAME>:
    url: "<ENGINE_MCP_URL>"
    auth: oauth
```

설정을 저장한 뒤 새 터미널에서 다음 명령으로 로그인하고 브라우저의 인증 절차를 완료한다. 실행 중인 세션의 설정 자동 재로드는 OAuth 대기 시간이 짧을 수 있으므로 별도 터미널의 로그인 명령을 사용한다는 점은 [공식 OAuth 안내](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp#oauth-authenticated-http-servers)에 명시되어 있다.

```bash
hermes mcp login "<MCP_SERVER_NAME>"
```

인증 뒤 새 세션을 시작하거나 `/reload-mcp`로 연결을 다시 읽는 방식은 [공식 MCP 문서](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)에 설명되어 있다. Hermes가 브라우저와 다른 호스트에서 실행되는 경우에는 loopback 콜백이 직접 도달하지 않으므로, [공식 원격 OAuth 안내](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp#oauth-authenticated-http-servers)에 따라 콜백 URL 붙여넣기나 SSH 포트 전달 등의 방식을 사용한다.

## 열린 쟁점
- 엔진의 Skill 배포 산출물, 공개 저장소의 Skill 경로, Claude Code 플러그인·marketplace 식별자와 실제 MCP URL은 지정되지 않았으므로 엔진 전용 설치 명령은 아직 제시할 수 없다.
- 메모리 파일을 모든 세션 시작에 반드시 읽게 만드는 클라이언트별 시작 문맥 주입 또는 자동 실행 방식은 엔진 배포 구성으로 검증되지 않았으므로, Skill 설치만으로 이 요구가 충족된다고 단정하지 않는다.

## 관련 문서
- [MCP](mcp.md)는 메모리 파일의 리소스·도구 노출과 읽기·쓰기·검색 계약을 설명한다.
- [쓰기 흐름](write-flow.md)은 클라이언트가 제출한 지식을 Luna가 반영하는 절차를 설명한다.
- [인증](auth.md)은 Google Workspace 로그인과 MCP OAuth의 엔진 측 계약을 설명한다.
