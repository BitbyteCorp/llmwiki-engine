# Codex 설치 안내

Codex에 `llmwiki` Skill을 로컬 복사하고, 엔진의 MCP 서버 연결과 OAuth 로그인을 별도로 설정하는 방법이다.

## 배경

사용 프롬프트의 원본은 [`skills/llmwiki/SKILL.md`](../llmwiki/SKILL.md)이며, 이 디렉터리에는 같은 `SKILL.md`를 중복해서 두지 않는다. Skill 파일을 배치하는 것만으로 MCP 연결이나 OAuth 로그인이 완료되지는 않는다. 공통 동작과 다른 클라이언트의 설치 방식은 [설치형 Skills 문서](../../docs/skills.md)를 따른다.

## 내용

### 1. Skill을 로컬에 복사한다

[Codex 공식 Skills 문서](https://developers.openai.com/codex/skills)에 따라 개인용 Skill은 `$HOME/.agents/skills` 아래에 둔다. 다음 명령은 **이 엔진 저장소의 루트에서 실행한다**. 설치된 Codex CLI를 사용하며, 복사 후 파일 경로는 `$HOME/.agents/skills/llmwiki/SKILL.md`가 된다.

```bash
mkdir -p "$HOME/.agents/skills"
cp -R skills/llmwiki "$HOME/.agents/skills/"
```

특정 프로젝트에만 적용하려면 개인용 설치 대신 해당 프로젝트의 `.agents/skills/llmwiki`에 원본 디렉터리를 복사한다. Codex는 현재 작업 디렉터리부터 저장소 루트까지 각 디렉터리의 `.agents/skills`를 탐색한다는 점이 [공식 로컬 Skill 위치 안내](https://developers.openai.com/codex/skills#where-to-save-skills)에 명시되어 있다. 같은 이름의 Skill을 개인용과 프로젝트용에 동시에 설치하면 선택 목록에 둘 다 표시될 수 있으므로 한 범위만 선택한다.

이 절차는 저장소의 원본을 로컬에 복사하는 방법이며, 배포 패키지나 marketplace 설치 명령이 아니다. 배포 방식은 아직 정하지 않았다.

### 2. MCP 서버를 별도로 설정한다

[Codex 공식 MCP 문서](https://developers.openai.com/codex/mcp)에 따라 기존 `~/.codex/config.toml`의 다른 설정을 보존하면서 다음 테이블을 추가한다. 이미 `[mcp_servers.llmwiki]`가 있다면 같은 테이블을 중복 선언하지 않고 기존 값을 수정한다.

```toml
[mcp_servers.llmwiki]
url = "https://wiki.example.com/mcp"
```

`https://wiki.example.com/mcp`는 **교체해야 하는 예시 URL**이다. 실제 URL은 배포된 엔진의 외부 기본 URL에 `/mcp`를 붙인 값으로 바꾼다. 엔진의 전송 방식은 Streamable HTTP이며, 해당 엔드포인트의 계약은 [MCP 문서](../../docs/mcp.md)를 따른다.

### 3. OAuth 로그인을 별도로 완료한다

[공식 CLI 안내](https://developers.openai.com/codex/mcp)에 따라 설정을 저장한 뒤 다음 명령을 터미널에서 실행한다.

```bash
codex mcp login llmwiki
```

명령이 안내하는 인증 절차에 따라 브라우저에서 엔진 로그인을 완료하고 접근을 승인한다. 엔진의 로그인과 접근 권한은 [인증 문서](../../docs/auth.md)를 따른다. 이 연결은 OAuth를 사용하므로 bearer 자격 증명을 직접 발급받아 설정에 넣는 방식으로 대체하지 않는다. Codex의 HTTP MCP 설정과 OAuth 지원은 [공식 Streamable HTTP 안내](https://developers.openai.com/codex/mcp#streamable-http-servers)에 명시되어 있다.

### 4. 새 세션에서 연결과 Skill을 확인한다

설정과 로그인을 마친 뒤 기존 Codex 실행을 종료하고, 사용할 프로젝트에서 다음 명령으로 새 세션을 시작한다.

```bash
codex
```

- `/mcp`를 열어 `llmwiki` 서버가 활성 서버 목록에 표시되는지 확인한다. 이 명령은 [공식 TUI 안내](https://developers.openai.com/codex/mcp)에 설명되어 있다.
- `/skills`에서 `llmwiki`를 선택하거나 프롬프트에 `$llmwiki`를 넣어 명시적으로 호출한다. 해당 선택 방식은 [공식 Skill 호출 안내](https://developers.openai.com/codex/skills#how-codex-uses-skills)에 설명되어 있다.
- `$llmwiki 기존 위키에서 관련 노트를 검색하고 근거를 읽어 요약한다`와 같은 읽기 요청으로 실제 MCP 도구 호출과 응답을 확인한다. Skill 목록 확인과 서버 목록 확인만으로 도구 실행 성공을 판단하지 않는다.

Codex는 Skill 변경을 자동으로 감지하지만 설치한 Skill이 나타나지 않으면 Codex를 재시작한다는 점이 [공식 Skills 문서](https://developers.openai.com/codex/skills)에 명시되어 있다. Skill이 보여도 MCP가 연결되지 않으면 서버 설정과 OAuth 로그인 단계를 별도로 확인한다.

## 관련 문서

- [설치형 Skills](../../docs/skills.md)는 공통 지식 활용 프롬프트와 클라이언트별 설치 계약을 설명한다.
- [MCP](../../docs/mcp.md)는 엔진의 도구와 Streamable HTTP 엔드포인트를 설명한다.
- [인증](../../docs/auth.md)은 엔진 로그인과 MCP OAuth를 설명한다.
