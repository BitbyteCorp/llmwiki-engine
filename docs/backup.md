# 내보내기와 백업
내보내기는 커밋된 지식을 배포하는 기능이고, 백업은 SQLite·지식 Git 이력·업로드를 함께 복구하는 기능이다.

## 배경
Git 원격 저장소만으로는 사용자, 대화, 작업 상태와 업로드를 복구할 수 없다. 반대로 실행 중인 SQLite 파일만 복사하면 WAL에 남은 변경을 빠뜨릴 수 있다. 백업은 `better-sqlite3`의 backup API로 일관된 DB 스냅샷을 만들고, 지식 저장소의 `main` 전체 이력을 Git bundle로 보관한다. 명령은 설정을 직접 읽으며 Nest 서버나 작업 큐를 시작하지 않는다. 특히 restore는 기존 데이터에 마이그레이션이나 저장소 부팅 정리를 먼저 실행하지 않는다.

## 내용
### 지식 내보내기
viewer 이상 사용자는 `GET /api/export?prefix=wiki/&format=zip`으로 커밋된 파일을 내려받는다. 인증에는 웹 세션 또는 `read` 범위의 REST bearer 토큰을 사용한다. `format`은 `zip`과 `bundle`이며 생략하면 ZIP이다. 응답의 파일명은 `llmwiki-<main SHA 앞 12자리>.zip` 또는 `.bundle`이다. `X-Export-Head`는 전체 커밋 SHA이며, `X-Export-Manifest`는 JSON manifest다. controller에 도달한 요청은 내보내기 준비·다운로드의 성공 또는 실패를 요청자 ID와 형식·prefix를 포함한 `knowledge.export` 감사 이벤트로 기록한다. 준비 전에 실패하면 대상은 `main`, 스냅샷을 준비한 뒤에는 전체 SHA다.

ZIP은 `git archive`의 stdout을 HTTP 응답으로 스트리밍한다. `prefix`는 저장소 상대 파일 또는 디렉터리 경로이며 원래 디렉터리 구조를 유지한다. 절대 경로, 역슬래시, `..`, `.git` 경로를 거부하고, 커밋된 파일이 없으면 404를 반환한다. ZIP의 루트 `manifest.json`에는 `version`, `headSha`, `createdAt`, `format`, `prefix`가 있다. 지식 저장소가 이미 루트 `manifest.json`을 추적하면 충돌을 피하려고 ZIP 내보내기를 409로 거부한다. 작업 디스크의 미커밋 수정은 포함하지 않는다.

Bundle은 `main`의 전체 Git 이력을 담는 원래 Git bundle 파일이다. 필터링된 Git 이력이라고 오해하지 않도록 bundle과 비어 있지 않은 `prefix`의 조합은 400으로 거부한다. bundle 안에 임의 JSON 파일을 삽입하지 않으며 HTTP에서는 manifest 헤더를, CLI에서는 `<출력 경로>.manifest.json` sidecar를 제공한다. bundle을 만드는 동안 main이 바뀌어도 manifest와 파일명은 실제 bundle이 광고하는 main SHA를 사용한다.

```bash
pnpm cli export --out /safe/location/knowledge.zip --prefix wiki/
pnpm cli export --out /safe/location/knowledge.bundle --format bundle
git clone -b main /safe/location/knowledge.bundle restored-knowledge
```

출력 파일과 bundle sidecar가 이미 있으면 덮어쓰지 않는다. 내보내기는 DB, 사용자, 대화, 업로드 디렉터리를 포함하지 않는다. 장애 복구에는 아래 백업 명령을 사용한다.

### 백업 생성과 검증
```bash
DATA_DIR=/srv/llmwiki/data pnpm cli backup create --out /safe/location/wiki-backup.zip
pnpm cli backup verify /safe/location/wiki-backup.zip
```

아카이브는 스트리밍 ZIP이며 다음 일반 파일만 포함한다.

| 파일 | 내용 |
| --- | --- |
| `manifest.json` | 아카이브 형식 버전 `1`, `schemaVersion`, 적용된 migration 파일명 목록, `headSha`, `startedAt`, `createdAt`, payload별 SHA-256이다. |
| `llmwiki.db` | backup API로 생성한 SQLite 스냅샷이다. WAL·SHM 파일을 개별 복사하지 않는다. |
| `knowledge.bundle` | `refs/heads/main`과 그 전체 조상 이력이다. 임시 작업 브랜치와 미커밋 작업 워크트리는 포함하지 않는다. |
| `uploads/<id>` | 스냅샷 DB의 `uploads` 행이 참조하는 모든 업로드 원본이다. 업로드 ID는 안전한 단일 파일명만 허용한다. |

업로드 파일은 생성 후 바뀌지 않는다. 스냅샷 DB가 참조하는 파일이 없거나 일반 파일이 아니면 생성이 실패하며 불완전한 아카이브를 남기지 않는다. DB와 Git은 서로 다른 저장소이므로 하나의 분산 트랜잭션으로 캡처하지 않는다. manifest의 두 타임스탬프는 캡처 구간을 나타낸다. 복원 후 RAG를 전체 재구축하여 DB의 파생 인덱스를 복원된 main과 다시 맞춘다. 진행 중인 작업의 미커밋 편집까지 보존하려면 먼저 작업 완료를 기다린다.

검증은 모든 payload의 SHA-256, 필수 파일과 manifest의 일치, SQLite `quick_check`, DB migration 목록, 업로드 참조 목록, Git bundle의 자체 검증과 main SHA를 확인한다. 엔진이 모르는 migration이 있거나 migration 순서가 현재 엔진의 알려진 순서와 맞지 않으면 거부한다. 현재 엔진보다 오래된 정상 migration prefix는 허용하며, 이후 서버 부팅에서 남은 migration을 적용한다. 검증은 실제 운영 DATA_DIR를 변경하지 않고 임시 디렉터리에서 수행한다.

생성이 성공하면 `DATA_DIR/last-backup.json`에 출력 절대 경로와 전체 manifest를 기록한다. 이는 마지막 생성 기록이지 해당 파일이 여전히 존재한다거나 다시 검증되었다는 보장은 아니다. CLI 백업 생성과 복원은 `audit_events` 테이블이 있을 때 각각 `backup.create`, `backup.restore` 감사 이벤트를 기록하며, 서버 로그인 요청이 아니므로 actor ID는 `null`이다. 생성 완료 이벤트는 원본 DB에, 복원 이벤트는 복원된 DB에 기록한다.

### 복원 절차와 안전장치
1. 대상 서버를 중지하고 작업이 끝났는지 확인한다.
2. 아카이브를 검증한다.
3. 빈 DATA_DIR로 복원하거나, 기존 데이터 교체를 의도한 경우에만 `--force`를 사용한다.
4. 서버를 정상 실행한다. 시작 시 RAG 동기화가 전체 인덱스를 재구축한다.

```bash
pnpm cli backup verify /safe/location/wiki-backup.zip
DATA_DIR=/srv/llmwiki/restored pnpm cli backup restore /safe/location/wiki-backup.zip
# 중지한 서버의 기존 데이터 전체를 교체하는 경우다.
DATA_DIR=/srv/llmwiki/data pnpm cli backup restore /safe/location/wiki-backup.zip --force
```

`--force` 없이 비어 있지 않은 DATA_DIR를 교체하지 않는다. `--force`를 붙여도 `DATA_DIR/server.pid`가 살아 있는 프로세스를 가리키면 항상 거부한다. Linux에서는 `/proc`의 열린 DB 파일도 확인하여 PID marker를 쓰지 않는 이전 엔진 프로세스를 보호한다. marker의 PID가 잘못된 경우에도 거부하며, 서버가 확실히 중지되었을 때만 잘못된 marker를 수동 제거한다. 다른 DATA_DIR에서 실행 중인 서버나 같은 URL의 다른 서비스는 복원 대상을 판단하는 근거로 사용하지 않는다.

루트 디렉터리, 사용자 홈, 현재 작업 디렉터리와 그 상위 디렉터리를 DATA_DIR로 복원하지 않는다. 대상 경로의 심볼릭 링크 구성 요소도 거부한다. 아카이브에서 허용된 상대 경로만 직접 일반 파일로 생성하므로 archive metadata의 심볼릭 링크·파일 권한·경로 순회를 적용하지 않는다. 중복 멤버와 알 수 없는 멤버는 거부한다.

복원은 DATA_DIR의 형제 임시 디렉터리에 파일을 풀어 검증하고, Git 저장소를 초기화해 bundle의 main을 fetch·checkout한다. `KNOWLEDGE_REPO_URL`이 설정되어 있으면 복원된 저장소의 origin으로 사용한다. 원본 Git 설정, SSH 비밀키와 hook은 아카이브에 포함하지 않는다. 검증이 끝나고 실행 중인 서버를 다시 확인한 뒤에만 기존 DATA_DIR를 이동하고 준비된 디렉터리를 교체한다. 새 디렉터리로 교체하는 rename이 실패하면 기존 디렉터리를 되돌린다. 성공한 교체는 기존 데이터 전체를 제거하므로 `--force` 전에는 별도 보존이 필요하다.

복원은 `index_meta`의 `indexed_sha`를 지워 다음 시작에서 전체 RAG 재구축을 유도하고, `rag-rebuild-required.json`에 복원 SHA와 시각을 남긴다. 이 파일은 복원 출처 기록이며 재구축 여부는 RAG 상태 API에서 확인한다. 세션·토큰 해시는 DB에 포함되지만 `SESSION_SECRET` 같은 환경변수, API 키와 배포 설정은 백업하지 않으므로 기존 설정을 별도로 보존한다. 아카이브에는 사용자와 대화의 민감한 데이터가 있으므로 공개 다운로드 위치에 두지 않는다.

### 모듈 인터페이스
`ExportModule`은 `ExportService`와 export HTTP controller를 제공한다. `ExportService.prepare({prefix?, format?})`는 `filename`, `contentType`, `manifest`, 읽기 스트림과 `dispose()`를 반환한다. 호출자는 성공·실패 시 스트림을 닫고 `dispose()`로 임시 bundle 또는 manifest 파일을 제거한다. `registerExportCommands(program)`과 `registerBackupCommands(program)`은 Commander에 직접 등록하며 Nest application getter를 받지 않는다. `BackupService(config)`는 `create(out)`, `verify(archive)`, `restore(archive, {force?})`를 제공한다. 세 메서드의 반환값은 출력 또는 입력 절대 `path`와 전체 backup manifest다.

## 관련 문서
- [지식 저장소](knowledge-repository.md)는 main과 원격 저장소의 역할을 설명한다.
- [개발 환경](development.md)은 DATA_DIR와 CLI 실행 방법을 설명한다.
- [RAG](rag.md)는 복원 후 파생 인덱스 재구축을 설명한다.
- [인증](auth.md)은 내보내기 요청의 세션과 bearer 토큰을 설명한다.
