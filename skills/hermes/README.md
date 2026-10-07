# Hermes에 llmwiki 설치

Nous Research의 Hermes Agent에 `llmwiki` Skill을 로컬 복사하고 엔진의 MCP 서버에 OAuth로 연결하는 안내다.

## 배경

Skill의 단일 원본은 [`skills/llmwiki/SKILL.md`](../llmwiki/SKILL.md)이며, 이 디렉터리에는 별도의 `SKILL.md`를 두지 않는다. 현재 공개된 llmwiki Skill 배포물이나 Hub 등록은 없으므로 엔진 저장소의 원본 디렉터리를 복사해 설치한다.

Skill 설치는 사용 지침을 배치하는 절차이고, MCP 연결 설정과 OAuth 로그인은 엔진 접근 권한을 얻는 별도 절차다. Skill을 복사한 것만으로 MCP 연결이나 로그인이 완료되지는 않는다.

## 설치와 연결

### 1. Skill을 로컬 복사한다

Hermes가 설치된 환경에서 아래 명령을 **llmwiki-engine 저장소 루트**에서 실행한다. [공식 Skills 문서](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)에 따라 기본 Skill 위치인 `~/.hermes/skills/` 아래에 원본 디렉터리의 내용을 복사한다.

```bash
mkdir -p ~/.hermes/skills/llmwiki
cp -R skills/llmwiki/. ~/.hermes/skills/llmwiki/
hermes skills list
```

목록에 `llmwiki`가 표시되는지 확인한다. 설치된 파일은 `~/.hermes/skills/llmwiki/SKILL.md`이며, 원본을 갱신한 뒤에는 같은 복사 명령으로 로컬 설치본을 갱신한다.

### 2. MCP 연결을 설정한다

[공식 MCP 문서](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)에 따라 `~/.hermes/config.yaml`에 아래 설정을 추가한다. 기존 `mcp_servers` 항목이 있으면 그 아래에 `llmwiki`를 병합하고 다른 서버 설정은 유지한다.

`https://wiki.example.com/mcp`는 **실제 배포 URL로 교체해야 하는 예시 URL**이다. 엔진의 배포된 기본 URL에 `/mcp`를 붙인 전체 주소를 사용하며, 엔진의 전송 방식은 Streamable HTTP다.

```yaml
mcp_servers:
  llmwiki:
    url: https://wiki.example.com/mcp
    auth: oauth
```

`auth: oauth`는 [공식 OAuth 안내](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp#oauth-authenticated-http-servers)에 따른 브라우저 인증 설정이다. Hermes는 서버의 인증 정보를 발견하고 OAuth 로그인과 토큰 갱신을 처리한다.

### 3. 별도 터미널에서 OAuth 로그인을 완료한다

설정을 저장한 뒤 실행 중인 Hermes 대화와 **별도의 새 터미널**에서 다음 명령을 실행하고, 안내된 인증 URL을 브라우저에서 열어 엔진 로그인을 완료한다.

```bash
hermes mcp login llmwiki
```

실행 중인 세션의 설정 자동 재로드는 대화형 OAuth에 필요한 대기 시간을 확보하지 못할 수 있으므로 별도 터미널의 로그인 명령을 사용한다는 점은 [공식 OAuth 안내](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp#oauth-authenticated-http-servers)와 [공식 저장소의 MCP 원문](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md)에 설명되어 있다.

Hermes와 브라우저가 다른 호스트에서 실행되는 경우에는 같은 [공식 OAuth 안내](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp#oauth-authenticated-http-servers)에 따라 리디렉션 URL 붙여넣기 또는 SSH 포트 전달로 콜백을 완료한다.

### 4. 새 세션에서 Skill을 사용한다

[공식 Skills 사용 가이드](https://hermes-agent.nousresearch.com/docs/guides/work-with-skills#installing-from-the-hub)에 따라 새로 설치한 Skill을 반영하려면 **새 Hermes 세션**을 시작한다.

```bash
hermes chat
```

[공식 MCP 재로드 안내](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp#reloading)에 따라 인증 완료 후 새 세션을 시작하거나, 기존 대화에서 다음 명령으로 MCP 연결과 도구 목록을 다시 읽는다.

```text
/reload-mcp
```

`/reload-mcp`는 MCP 연결을 갱신하는 명령이며, 새 Skill을 반영하기 위한 새 세션 시작과는 구분한다. [공식 Skills 사용 가이드](https://hermes-agent.nousresearch.com/docs/guides/work-with-skills#using-a-skill)에 따라 새 세션의 대화에서 다음 명령으로 Skill을 명시적으로 불러온다.

```text
/llmwiki
```

Skill을 불러온 뒤 위키에 관한 질문으로 검색과 노트 읽기를 요청해 실제 MCP 도구 사용 결과를 확인한다. 쓰기 동작과 권한은 엔진의 [MCP 문서](../../docs/mcp.md)와 [인증 문서](../../docs/auth.md)를 따른다.

## 관련 문서

- [설치형 Skills](../../docs/skills.md)는 공통 사용 지침과 다른 클라이언트의 설치 방식을 설명한다.
- [MCP](../../docs/mcp.md)는 엔진의 읽기·쓰기·검색 계약을 설명한다.
- [인증](../../docs/auth.md)은 엔진 로그인과 접근 권한을 설명한다.
