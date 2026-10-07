# Hermes 설치 자료
Nous Research의 Hermes Agent에 llmwiki Skill을 설치하고 MCP OAuth를 별도로 연결하는 자료다.

## 배경
공통 프롬프트의 단일 원본은 `skills/llmwiki/SKILL.md`다. 이 디렉터리는 설치 시 Skill 디렉터리의 `client/`에 복사된다. `mcp.example.yaml`은 병합용 예시이며 활성 설정이 아니다.

## 내용
`llmwiki skill install hermes`는 [공식 Skills 문서](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)에 따라 `~/.hermes/skills/llmwiki`에 설치한다. `--project <dir>`는 공식 프로젝트 위치인 `<dir>/.hermes/skills/llmwiki`를 선택한다. 프로젝트 Skill은 신뢰한 저장소에서 사용한다. `llmwiki skill status hermes`로 버전과 로컬 수정을 확인하고 `llmwiki skill update hermes`로 갱신한다. 같은 프로젝트 옵션을 조회와 갱신에도 사용한다. 로컬 수정과 표식 없는 기존 파일은 기본적으로 보존하며 검토 후 `--force`로 Skill 파일만 교체한다.

Hermes는 `.git`이 있는 프로젝트 루트의 Skill을 탐색한다. `--project`에는 이 루트를 지정하고, 설치 후 사용자가 별도로 `hermes skills trust <dir>`를 실행한다. 설치기는 신뢰 설정을 수정하지 않는다.

[공식 MCP 문서](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)에 따라 기존 `~/.hermes/config.yaml`의 `mcp_servers`에 `mcp.example.yaml`의 llmwiki 항목을 병합한다. 예시 URL은 실제 엔진 기본 URL에 `/mcp`를 붙인 값으로 바꾸고 `auth: oauth`를 유지한다. 기존 다른 서버 설정은 보존한다. 설치기는 설정과 비밀값을 쓰지 않는다.

별도 터미널에서 `hermes mcp login llmwiki`로 브라우저 OAuth 로그인을 완료한다. 새 Hermes 세션에서 `/llmwiki`를 호출하고 실제 검색과 노트 읽기 결과로 연결을 확인한다. `/reload-mcp`는 기존 세션의 MCP 재로드이며 새 Skill 반영과 구분한다. 브라우저와 Hermes가 다른 호스트에 있으면 공식 문서의 원격 콜백 절차를 따른다.

## 관련 문서
저장소의 `docs/skills.md`는 버전 표식, 수정 보호, 전체 설치 위치를 설명한다. `docs/mcp.md`와 `docs/auth.md`는 도구와 인증 계약을 설명한다.
