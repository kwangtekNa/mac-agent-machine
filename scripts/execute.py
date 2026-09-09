#!/usr/bin/env python3
"""
Harness Step Executor — phase 내 step을 순차 실행하고 자가 교정한다.

세션과의 계약 (v2): 세션은 코드 작업만 하고, 최종 결과를 구조화 출력
(--json-schema)으로 보고한다. index.json 기록과 git 커밋은 executor 전담.

Usage:
    python3 scripts/execute.py <phase-dir> [--push] [--quiet] [--parallel N]
"""

import argparse
import contextlib
import json
import os
import subprocess
import sys
import threading
import time
import types
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

def _find_project_root() -> Path:
    """실행 대상 프로젝트의 루트를 찾는다.

    플러그인으로 설치되면 이 파일은 플러그인 캐시(~/.claude/plugins/...)에
    있으므로 __file__ 기준 경로는 쓸 수 없다. HARNESS_ROOT 환경변수 →
    git toplevel → cwd 순으로 해석한다.
    """
    env_root = os.environ.get("HARNESS_ROOT")
    if env_root:
        return Path(env_root).resolve()
    r = subprocess.run(["git", "rev-parse", "--show-toplevel"],
                       capture_output=True, text=True)
    if r.returncode == 0 and r.stdout.strip():
        return Path(r.stdout.strip())
    return Path.cwd()


ROOT = _find_project_root()

# 세션이 --json-schema로 강제 보고하는 최종 결과 스키마.
# 세션은 이 구조화 출력 외에는 어떤 상태 파일도 직접 쓰지 않는다.
STEP_RESULT_SCHEMA = {
    "type": "object",
    "properties": {
        "status": {
            "type": "string",
            "enum": ["completed", "error", "blocked", "needs_input"],
            "description": "step 수행 결과",
        },
        "summary": {
            "type": "string",
            "description": "completed일 때: 산출물 한 줄 요약 (생성/수정 파일, 핵심 결정 — 다음 step 프롬프트에 전달된다)",
        },
        "error_message": {
            "type": "string",
            "description": "error일 때: 구체적 에러 내용",
        },
        "blocked_reason": {
            "type": "string",
            "description": "blocked일 때: 사용자 개입이 필요한 사유",
        },
        "questions": {
            "type": "array",
            "description": "needs_input일 때: 사용자에게 물을 질문 목록",
            "items": {
                "type": "object",
                "properties": {
                    "question": {"type": "string"},
                    "context": {
                        "type": "string",
                        "description": "질문 배경과 고려 중인 선택지 설명",
                    },
                },
                "required": ["question"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["status"],
    "additionalProperties": False,
}


@contextlib.contextmanager
def progress_indicator(label: str):
    """터미널 진행 표시기. with 문으로 사용하며 .elapsed 로 경과 시간을 읽는다."""
    frames = "◐◓◑◒"
    stop = threading.Event()
    t0 = time.monotonic()

    def _animate():
        idx = 0
        while not stop.wait(0.12):
            sec = int(time.monotonic() - t0)
            sys.stderr.write(f"\r{frames[idx % len(frames)]} {label} [{sec}s]")
            sys.stderr.flush()
            idx += 1
        sys.stderr.write("\r" + " " * (len(label) + 20) + "\r")
        sys.stderr.flush()

    th = threading.Thread(target=_animate, daemon=True)
    th.start()
    info = types.SimpleNamespace(elapsed=0.0)
    try:
        yield info
    finally:
        stop.set()
        th.join()
        info.elapsed = time.monotonic() - t0


@contextlib.contextmanager
def _elapsed_timer():
    """스피너 없이 경과 시간만 측정한다 (progress_indicator와 동일 인터페이스).

    스트리밍 모드에서 사용 — 스피너와 스트리밍 출력을 동시에 켜면 터미널이 깨진다.
    """
    info = types.SimpleNamespace(elapsed=0.0)
    t0 = time.monotonic()
    try:
        yield info
    finally:
        info.elapsed = time.monotonic() - t0


class IndexSchemaError(ValueError):
    """phase index.json이 필수 스키마를 위반할 때 발생한다."""


_CLI_RESULT_KEYS = ("session_id", "total_cost_usd", "usage", "num_turns",
                    "duration_ms", "is_error", "result", "subtype",
                    "structured_output")


def parse_cli_result(stdout: str) -> dict:
    """claude -p --output-format json의 stdout에서 마지막 JSON 오브젝트를 파싱한다.

    뒤에서부터 줄 단위로 시도하는 이유: stream-json(JSONL)의 마지막
    type:"result" 줄을 그대로 넣어도 동작해야 한다. 파싱 불가능한 입력이면
    {}를 반환하고, 어떤 입력에도 예외를 던지지 않는다.
    """
    obj = None
    if isinstance(stdout, str):
        for line in reversed(stdout.splitlines()):
            try:
                candidate = json.loads(line)
            except Exception:
                continue
            if isinstance(candidate, dict):
                obj = candidate
                break
        if obj is None:
            try:
                candidate = json.loads(stdout)
                if isinstance(candidate, dict):
                    obj = candidate
            except Exception:
                pass
    if obj is None:
        return {}
    return {k: obj.get(k) for k in _CLI_RESULT_KEYS}


def generate_report(index: dict) -> str:
    """phase index를 사람이 읽을 마크다운 리포트로 변환한다.

    이 기능이 없던 과거 phase의 index에도 동작해야 한다 — 없는 필드는
    '-'로 렌더링하고, 어떤 index 형태에도 예외를 던지지 않는다.
    """
    if not isinstance(index, dict):
        index = {}

    def fmt(value):
        return "-" if value is None else str(value)

    raw_steps = index.get("steps")
    steps = [s for s in raw_steps if isinstance(s, dict)] if isinstance(raw_steps, list) else []
    completed = sum(1 for s in steps if s.get("status") == "completed")

    lines = [
        f"# {fmt(index.get('project'))} / {fmt(index.get('phase'))}",
        "",
        "## 요약",
        "",
        f"- 총 step: {len(steps)}",
        f"- completed: {completed}",
        f"- total_cost_usd: {fmt(index.get('total_cost_usd'))}",
        f"- total_duration_s: {fmt(index.get('total_duration_s'))}",
        f"- created_at: {fmt(index.get('created_at'))}",
        f"- completed_at: {fmt(index.get('completed_at'))}",
        "",
        "## Steps",
        "",
        "| step | name | status | duration_s | cost_usd | retries | interviews |",
        "|---|---|---|---|---|---|---|",
    ]
    for s in steps:
        interviews = s.get("interviews")
        n_interviews = len(interviews) if isinstance(interviews, list) else None
        cells = [fmt(s.get(k)) for k in
                 ("step", "name", "status", "duration_s", "cost_usd", "retries")]
        cells.append(fmt(n_interviews))
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines) + "\n"


class WorktreeRunner:
    """의존성 없는 step들을 git worktree로 격리해 동시 실행하기 위한 러너.

    step마다 base_branch HEAD 기준의 워크트리(.worktrees/step{N})와 브랜치
    (wt/{phase}/step{N})를 만들고, 세션이 워크트리 안에서 작업한 결과를
    커밋(commit_step)·병합(merge)·정리(remove)한다. 생성자는 부수효과가 없다.
    """

    def __init__(self, root: Path, phase_dir_name: str, base_branch: str):
        self._root = Path(root)
        self._phase_dir_name = phase_dir_name
        self._base_branch = base_branch

    def _git(self, *args) -> subprocess.CompletedProcess:
        return subprocess.run(["git"] + list(args), cwd=self._root,
                              capture_output=True, text=True)

    def _git_wt(self, step_num: int, *args) -> subprocess.CompletedProcess:
        return subprocess.run(["git"] + list(args), cwd=self._wt_path(step_num),
                              capture_output=True, text=True)

    def _wt_path(self, step_num: int) -> Path:
        return self._root / ".worktrees" / f"step{step_num}"

    def _wt_branch(self, step_num: int) -> str:
        return f"wt/{self._phase_dir_name}/step{step_num}"

    def create(self, step_num: int) -> Path:
        path = self._wt_path(step_num)
        r = self._git("worktree", "add", str(path),
                      "-b", self._wt_branch(step_num), self._base_branch)
        if r.returncode != 0:
            raise RuntimeError(
                f"git worktree add 실패 (step {step_num}): {r.stderr.strip()}")
        return path

    def commit_step(self, step_num: int, message: str) -> None:
        """워크트리 안에서 세션의 작업 결과를 커밋한다 (v2: 세션은 커밋하지 않는다).

        phase index.json은 스테이징에서 제외한다 — 세션이 지시를 어기고 만졌더라도
        메인과의 머지 충돌을 만들지 않기 위함이다. 변경이 없으면 커밋을 만들지
        않으며, 이 경우 merge는 "Already up to date"로 무해하게 끝난다.
        """
        index_rel = f"phases/{self._phase_dir_name}/index.json"
        self._git_wt(step_num, "add", "-A")
        self._git_wt(step_num, "reset", "HEAD", "--", index_rel)
        if self._git_wt(step_num, "diff", "--cached", "--quiet").returncode != 0:
            self._git_wt(step_num, "commit", "-m", message)

    def merge(self, step_num: int) -> subprocess.CompletedProcess:
        """wt 브랜치를 base_branch에 merge --no-ff. 충돌 시 abort 후 실패 반환.

        v2에서는 워크트리가 phase index.json을 수정하지 않으므로 구조적 충돌이
        없다. 남는 충돌은 진짜 코드 충돌뿐이라 자동 해소하지 않는다.
        """
        r = self._git("merge", "--no-ff", "--no-edit", self._wt_branch(step_num))
        if r.returncode != 0:
            self._git("merge", "--abort")
        return r

    def remove(self, step_num: int) -> None:
        self._git("worktree", "remove", "--force", str(self._wt_path(step_num)))
        self._git("branch", "-D", self._wt_branch(step_num))


class StepExecutor:
    """Phase 디렉토리 안의 step들을 순차 실행하는 하네스."""

    MAX_RETRIES = 3
    MAX_INTERVIEW_ROUNDS = 3
    STEP_STATUSES = ("pending", "completed", "error", "blocked")
    EFFORT_LEVELS = ("low", "medium", "high", "xhigh", "max")
    FEAT_MSG = "feat({phase}): step {num} — {name}"
    CHORE_MSG = "chore({phase}): step {num} output"
    TZ = timezone(timedelta(hours=9))

    def __init__(self, phase_dir_name: str, *, auto_push: bool = False,
                 quiet: bool = False, parallel: int = 1):
        self._root = str(ROOT)
        self._phases_dir = ROOT / "phases"
        self._phase_dir = self._phases_dir / phase_dir_name
        self._phase_dir_name = phase_dir_name
        self._top_index_file = self._phases_dir / "index.json"
        self._auto_push = auto_push
        self._quiet = quiet
        self._parallel = parallel
        self._config = self._load_harness_config()
        # 병렬 경로에서 메인 index.json 읽기-수정-쓰기와 메인 repo git 작업을 직렬화한다
        self._index_lock = threading.Lock()
        # 인터뷰는 한 번에 한 step만 터미널을 점유한다
        self._interview_lock = threading.Lock()

        if not self._phase_dir.is_dir():
            print(f"ERROR: {self._phase_dir} not found")
            sys.exit(1)

        self._index_file = self._phase_dir / "index.json"
        if not self._index_file.exists():
            print(f"ERROR: {self._index_file} not found")
            sys.exit(1)

        idx = self._load_index()
        self._project = idx.get("project", "project")
        self._phase_name = idx.get("phase", phase_dir_name)
        self._total = len(idx["steps"])

    def run(self):
        self._acquire_lock()
        try:
            self._print_header()
            # blocker 체크 전에 스키마·DAG 위반을 조기 검출
            self._validate_dag(self._load_index())
            self._check_blockers()
            self._checkout_branch()
            guardrails = self._load_guardrails()
            self._ensure_created_at()
            self._execute_all_steps(guardrails)
            self._finalize()
        finally:
            # sys.exit()도 SystemExit 예외라 finally를 통과한다 — 모든 종료 경로에서 락 해제
            self._release_lock()

    # --- timestamps ---

    def _stamp(self) -> str:
        return datetime.now(self.TZ).strftime("%Y-%m-%dT%H:%M:%S%z")

    # --- JSON I/O ---

    @staticmethod
    def _read_json(p: Path) -> dict:
        return json.loads(p.read_text(encoding="utf-8"))

    @staticmethod
    def _write_json(p: Path, data: dict) -> None:
        # 임시 파일에 쓴 뒤 os.replace로 교체 — 쓰기 도중 죽어도 기존 파일이 깨지지 않는다
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, p)

    @staticmethod
    def _load_harness_config() -> dict:
        """프로젝트 루트의 .harness.json을 읽는다. 없거나 깨졌으면 {}.

        지원 필드: test_command(Stop 훅용), step_budget_usd, fallback_model,
        test_timeout(Stop 훅용). 미지 필드는 무시한다.
        """
        try:
            data = json.loads((ROOT / ".harness.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    @staticmethod
    def _validate_index(index: dict) -> None:
        # 필수 필드만 검사한다. 미지(unknown) 필드는 이후 step들이 추가하므로 항상 유효로 취급.
        if not isinstance(index, dict):
            raise IndexSchemaError("index는 JSON 객체여야 한다")
        for key in ("project", "phase"):
            if not isinstance(index.get(key), str):
                raise IndexSchemaError(f"'{key}'는 필수 문자열 필드다")
        steps = index.get("steps")
        if not isinstance(steps, list):
            raise IndexSchemaError("'steps'는 필수 리스트 필드다")
        for i, s in enumerate(steps):
            if not isinstance(s, dict):
                raise IndexSchemaError(f"steps[{i}]는 JSON 객체여야 한다")
            if isinstance(s.get("step"), bool) or not isinstance(s.get("step"), int):
                raise IndexSchemaError(f"steps[{i}].step은 필수 정수 필드다")
            if not isinstance(s.get("name"), str):
                raise IndexSchemaError(f"steps[{i}].name은 필수 문자열 필드다")
            if s.get("status") not in StepExecutor.STEP_STATUSES:
                raise IndexSchemaError(
                    f"steps[{i}].status는 {'|'.join(StepExecutor.STEP_STATUSES)} 중 하나여야 한다"
                )
            if "model" in s and (not isinstance(s.get("model"), str) or not s["model"]):
                raise IndexSchemaError(f"steps[{i}].model은 비어있지 않은 문자열이어야 한다")
            if "effort" in s and s.get("effort") not in StepExecutor.EFFORT_LEVELS:
                raise IndexSchemaError(
                    f"steps[{i}].effort는 {'|'.join(StepExecutor.EFFORT_LEVELS)} 중 하나여야 한다"
                )

    def _load_index(self) -> dict:
        index = self._read_json(self._index_file)
        self._validate_index(index)
        return index

    # --- DAG 스케줄링 ---

    def _step_deps(self, step: dict, known: set) -> set:
        # depends_on 부재 시 = 모든 선행 step(자신보다 작은 번호 전부)에 의존
        # → 기존 순차 실행과 정확히 동일한 동작
        declared = step.get("depends_on")
        if declared is None:
            return {n for n in known if n < step["step"]}
        return set(declared)

    def _validate_dag(self, index: dict) -> None:
        known = {s["step"] for s in index["steps"]}
        deps = {}
        for s in index["steps"]:
            num = s["step"]
            declared = s.get("depends_on")
            if declared is not None:
                if not isinstance(declared, list):
                    raise IndexSchemaError(f"step {num}의 depends_on은 step 번호 리스트여야 한다")
                for d in declared:
                    if d == num:
                        raise IndexSchemaError(f"step {num}이 자기 자신에 의존한다")
                    if d not in known:
                        raise IndexSchemaError(f"step {num}이 존재하지 않는 step {d}에 의존한다")
            deps[num] = self._step_deps(s, known)

        # Kahn 위상정렬 — 의존이 모두 해소된 step을 반복 제거하고, 남았는데
        # 제거할 것이 없으면 순환. 암묵 의존과 섞인 순환(1→2, 2→암묵 1)도 잡는다.
        while deps:
            resolved = {n for n, d in deps.items() if not d}
            if not resolved:
                cycle = ", ".join(str(n) for n in sorted(deps))
                raise IndexSchemaError(f"steps 간 순환 의존이 있다: {cycle}")
            deps = {n: d - resolved for n, d in deps.items() if n not in resolved}

    def _ready_steps(self, index: dict) -> list[dict]:
        """pending이고 의존 step이 모두 completed인 step들을 step 번호 순으로 반환한다."""
        status = {s["step"]: s["status"] for s in index["steps"]}
        ready = [
            s for s in index["steps"]
            if s["status"] == "pending"
            and all(status.get(d) == "completed"
                    for d in self._step_deps(s, set(status)))
        ]
        return sorted(ready, key=lambda s: s["step"])

    # --- lockfile ---

    def _acquire_lock(self) -> None:
        lock = self._phase_dir / ".lock"
        if lock.exists():
            try:
                pid = int(lock.read_text().strip())
            except ValueError:
                pid = None  # 손상된 락파일은 stale로 간주
            if pid is not None:
                try:
                    os.kill(pid, 0)
                    alive = True
                except ProcessLookupError:
                    alive = False
                except PermissionError:
                    alive = True  # 시그널 권한이 없어도 프로세스는 존재한다
                if alive:
                    print(f"ERROR: 이미 실행 중인 executor(pid {pid})가 있다")
                    sys.exit(1)
        lock.write_text(str(os.getpid()), encoding="utf-8")

    def _release_lock(self) -> None:
        (self._phase_dir / ".lock").unlink(missing_ok=True)

    # --- git ---

    def _run_git(self, *args) -> subprocess.CompletedProcess:
        cmd = ["git"] + list(args)
        return subprocess.run(cmd, cwd=self._root, capture_output=True, text=True)

    def _checkout_branch(self):
        branch = f"feat-{self._phase_name}"

        r = self._run_git("rev-parse", "--abbrev-ref", "HEAD")
        if r.returncode != 0:
            print(f"  ERROR: git을 사용할 수 없거나 git repo가 아닙니다.")
            print(f"  {r.stderr.strip()}")
            sys.exit(1)

        if r.stdout.strip() == branch:
            return

        r = self._run_git("rev-parse", "--verify", branch)
        r = self._run_git("checkout", branch) if r.returncode == 0 else self._run_git("checkout", "-b", branch)

        if r.returncode != 0:
            print(f"  ERROR: 브랜치 '{branch}' checkout 실패.")
            print(f"  {r.stderr.strip()}")
            print(f"  Hint: 변경사항을 stash하거나 commit한 후 다시 시도하세요.")
            sys.exit(1)

        print(f"  Branch: {branch}")

    def _commit_step(self, step_num: int, step_name: str):
        output_rel = f"phases/{self._phase_dir_name}/step{step_num}-output.json"
        index_rel = f"phases/{self._phase_dir_name}/index.json"

        self._run_git("add", "-A")
        self._run_git("reset", "HEAD", "--", output_rel)
        self._run_git("reset", "HEAD", "--", index_rel)

        if self._run_git("diff", "--cached", "--quiet").returncode != 0:
            msg = self.FEAT_MSG.format(phase=self._phase_name, num=step_num, name=step_name)
            r = self._run_git("commit", "-m", msg)
            if r.returncode == 0:
                print(f"  Commit: {msg}")
            else:
                print(f"  WARN: 코드 커밋 실패: {r.stderr.strip()}")

        self._run_git("add", "-A")
        if self._run_git("diff", "--cached", "--quiet").returncode != 0:
            msg = self.CHORE_MSG.format(phase=self._phase_name, num=step_num)
            r = self._run_git("commit", "-m", msg)
            if r.returncode != 0:
                print(f"  WARN: housekeeping 커밋 실패: {r.stderr.strip()}")

    def _commit_phase_metadata(self):
        """병렬 머지 전 메인 워킹트리를 clean하게 만든다.

        병렬 실행 중 executor가 메인 phase index에 쓴 시도 메타데이터가 커밋되지
        않은 채 남아 있으면 git이 merge를 거부한다("Your local changes ...").
        """
        self._run_git("add", f"phases/{self._phase_dir_name}")
        if self._run_git("diff", "--cached", "--quiet").returncode != 0:
            r = self._run_git(
                "commit", "-m", f"chore({self._phase_name}): 병렬 실행 메타데이터")
            if r.returncode != 0:
                print(f"  WARN: 메타데이터 커밋 실패: {r.stderr.strip()}")

    # --- top-level index ---

    def _update_top_index(self, status: str):
        if not self._top_index_file.exists():
            return
        top = self._read_json(self._top_index_file)
        ts = self._stamp()
        for phase in top.get("phases", []):
            if phase.get("dir") == self._phase_dir_name:
                phase["status"] = status
                ts_key = {"completed": "completed_at", "error": "failed_at", "blocked": "blocked_at"}.get(status)
                if ts_key:
                    phase[ts_key] = ts
                break
        self._write_json(self._top_index_file, top)

    # --- guardrails & context ---

    def _load_guardrails(self) -> str:
        # CLAUDE.md만 인라인한다 — CRITICAL 규칙은 세션이 생략할 수 없어야 한다.
        # docs/*.md는 _build_doc_refs의 경로 참조로 대체해 매 시도마다의 토큰 낭비를 줄인다.
        claude_md = ROOT / "CLAUDE.md"
        if claude_md.exists():
            return f"## 프로젝트 규칙 (CLAUDE.md)\n\n{claude_md.read_text()}"
        return ""

    def _build_doc_refs(self, step: dict) -> str:
        doc_paths = step.get("docs")
        if doc_paths is None:
            docs_dir = ROOT / "docs"
            if not docs_dir.is_dir():
                return ""
            doc_paths = [f"/docs/{doc.name}" for doc in sorted(docs_dir.glob("*.md"))]
        if not doc_paths:
            return ""
        lines = "\n".join(f"- {p if p.startswith('/') else '/' + p}" for p in doc_paths)
        return (
            "## 참고 문서\n\n"
            "작업 전에 아래 문서를 반드시 Read 도구로 직접 읽어라:\n"
            f"{lines}"
        )

    @staticmethod
    def _build_step_context(index: dict) -> str:
        lines = [
            f"- Step {s['step']} ({s['name']}): {s['summary']}"
            for s in index["steps"]
            if s["status"] == "completed" and s.get("summary")
        ]
        if not lines:
            return ""
        return "## 이전 Step 산출물\n\n" + "\n".join(lines) + "\n\n"

    @staticmethod
    def _build_interview_context(index: dict, step_num: int) -> str:
        """해당 step에 기록된 인터뷰 Q&A를 프롬프트 섹션으로 만든다. 없으면 ""."""
        entry = next((s for s in index["steps"] if s.get("step") == step_num), {})
        items = [i for i in entry.get("interviews", [])
                 if isinstance(i, dict) and i.get("question")]
        if not items:
            return ""
        lines = "\n".join(
            f"- Q: {i['question']}\n  A: {i.get('answer') or '(무응답 — 재량으로 결정하라)'}"
            for i in items
        )
        return (
            "## 사용자 인터뷰 답변\n\n"
            "세션의 질문에 사용자가 답한 내용이다. 반드시 반영하고, 같은 질문을 다시 하지 마라:\n\n"
            f"{lines}\n\n"
        )

    def _build_preamble(self, guardrails: str, doc_refs: str, step_context: str,
                        prev_error: Optional[str] = None,
                        interview_context: str = "") -> str:
        doc_refs_section = f"{doc_refs}\n\n---\n\n" if doc_refs else ""
        retry_section = ""
        if prev_error:
            retry_section = (
                f"\n## ⚠ 이전 시도 실패 — 아래 에러를 반드시 참고하여 수정하라\n\n"
                f"{prev_error}\n\n---\n\n"
            )
        return (
            f"당신은 {self._project} 프로젝트의 개발자입니다. 아래 step을 수행하세요.\n\n"
            f"{guardrails}\n\n---\n\n"
            f"{doc_refs_section}"
            f"{step_context}{interview_context}{retry_section}"
            f"## 작업 규칙\n\n"
            f"1. 위 참고 문서와 이전 step에서 작성된 코드를 먼저 읽고 일관성을 유지하라.\n"
            f"2. 이 step에 명시된 작업만 수행하라. 추가 기능이나 파일을 만들지 마라.\n"
            f"3. 기존 테스트를 깨뜨리지 마라.\n"
            f"4. 구현 .py 파일은 대응 테스트를 먼저 작성한 뒤 수정하라. tdd-guard 훅은\n"
            f"   같은 디렉토리·같은 디렉토리의 tests/·프로젝트 루트 tests/ 중 한 곳에\n"
            f"   test_{{이름}}.py 또는 {{이름}}_test.py가 없으면 Edit/Write를 차단한다.\n"
            f"5. AC(Acceptance Criteria) 검증을 직접 실행하라.\n"
            f"6. git commit/push를 직접 실행하지 마라 — 커밋은 executor가 수행한다.\n"
            f"   phases/ 아래 파일(index.json 포함)도 수정하지 마라.\n"
            f"7. 작업이 끝나면 최종 결과를 구조화 출력으로 보고하라:\n"
            f"   - AC 통과 → status \"completed\" + summary(산출물 한 줄 요약)\n"
            f"   - {self.MAX_RETRIES}회 수정 시도 후에도 실패 → \"error\" + error_message\n"
            f"   - 사용자 개입 필요 (API 키, 인증, 수동 설정 등) → \"blocked\" + blocked_reason 후 즉시 중단\n"
            f"   - AC 달성에 영향을 주는 모호함·설계 분기 → \"needs_input\" + questions.\n"
            f"     사소한 결정은 스스로 내려라 — 질문은 사용자만 답할 수 있는 사항으로 제한한다.\n\n---\n\n"
        )

    # --- 시도 이력 기록 ---

    def _record_attempt(self, step_num: int, attempt: int, parsed: dict,
                        elapsed_s: float, *,
                        timeout: bool = False, exit_code: int = 0,
                        interview: bool = False) -> None:
        index = self._load_index()
        for s in index["steps"]:
            if s["step"] == step_num:
                attempts = s.setdefault("attempts", [])
                entry = {
                    "attempt": attempt,
                    "session_id": parsed.get("session_id"),
                    "cost_usd": parsed.get("total_cost_usd"),
                    "duration_s": round(elapsed_s, 1),
                    "num_turns": parsed.get("num_turns"),
                    "exit_code": exit_code,
                    "timeout": timeout,
                }
                if interview:
                    # needs_input 라운드는 실패가 아니다 — retries 집계에서 제외
                    entry["interview"] = True
                attempts.append(entry)
                s["cost_usd"] = round(sum(a["cost_usd"] or 0 for a in attempts), 6)
                s["duration_s"] = round(sum(a["duration_s"] or 0 for a in attempts), 1)
                s["retries"] = max(
                    0, sum(1 for a in attempts if not a.get("interview")) - 1)
                session_ids = [a["session_id"] for a in attempts if a["session_id"]]
                if session_ids:
                    s["session_id"] = session_ids[-1]
                break
        self._write_json(self._index_file, index)

    def _record_interviews(self, step_num: int, qa: list) -> None:
        """인터뷰 Q&A를 step 엔트리에 누적 기록한다 (재실행에도 보존)."""
        if not qa:
            return
        index = self._load_index()
        for s in index["steps"]:
            if s["step"] == step_num:
                s.setdefault("interviews", []).extend(qa)
                break
        self._write_json(self._index_file, index)

    # --- 인터뷰 ---

    @staticmethod
    def _stdin_interactive() -> bool:
        try:
            return sys.stdin is not None and sys.stdin.isatty()
        except Exception:
            return False

    def _conduct_interview(self, step_num: int, step_name: str,
                           questions: list) -> list:
        """세션이 요청한 질문을 터미널에서 사용자에게 중계하고 답변을 수집한다.

        병렬 실행 중에도 한 번에 한 step만 터미널을 점유한다 (_interview_lock).
        """
        valid = [q for q in questions
                 if isinstance(q, dict) and q.get("question")]
        qa = []
        with self._interview_lock:
            print(f"\n  ❓ Step {step_num} ({step_name}) 세션이 사용자 입력을 요청했다:",
                  flush=True)
            for i, q in enumerate(valid, 1):
                print(f"\n  [{i}/{len(valid)}] {q['question']}", flush=True)
                if q.get("context"):
                    print(f"      {q['context']}", flush=True)
                try:
                    answer = input("  답변> ").strip()
                except EOFError:
                    answer = ""
                qa.append({"question": q["question"], "answer": answer,
                           "at": self._stamp()})
        return qa

    @staticmethod
    def _questions_to_reason(degrade: str, questions: list) -> str:
        qs = " / ".join(q.get("question", "") for q in questions
                        if isinstance(q, dict) and q.get("question"))
        return f"{degrade} — 세션의 질문: {qs or '(질문 없음)'}"

    # --- Claude 호출 ---

    @staticmethod
    def _step_timeout() -> int:
        return int(os.environ.get("HARNESS_STEP_TIMEOUT", "1800"))

    def _step_budget_usd(self) -> Optional[float]:
        """시도당 비용 상한. env HARNESS_STEP_BUDGET_USD → .harness.json 순."""
        env = os.environ.get("HARNESS_STEP_BUDGET_USD")
        if env:
            try:
                return float(env)
            except ValueError:
                pass
        v = self._config.get("step_budget_usd")
        if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
            return float(v)
        return None

    def _invoke_claude(self, step: dict, preamble: str, attempt: int = 1, *,
                       cwd: Optional[Path] = None,
                       quiet: Optional[bool] = None) -> dict:
        step_num, step_name = step["step"], step["name"]
        step_file = self._phase_dir / f"step{step_num}.md"

        if not step_file.exists():
            print(f"  ERROR: {step_file} not found")
            sys.exit(1)

        # -p + stream-json 조합은 --verbose가 없으면 CLI가 에러를 낸다 (v2.1.220 확인).
        # --json-schema로 세션의 최종 보고를 구조화 출력으로 강제하고,
        # --include-hook-events로 가드 훅 발동을 JSONL 로그에 남긴다.
        cmd = ["claude", "-p", "--dangerously-skip-permissions",
               "--output-format", "stream-json", "--verbose",
               "--include-hook-events",
               "--json-schema", json.dumps(STEP_RESULT_SCHEMA)]
        budget = self._step_budget_usd()
        if budget is not None:
            cmd += ["--max-budget-usd", str(budget)]
        fallback = self._config.get("fallback_model")
        if isinstance(fallback, str) and fallback:
            cmd += ["--fallback-model", fallback]
        if step.get("model"):
            cmd += ["--model", step["model"]]
        if step.get("effort"):
            cmd += ["--effort", step["effort"]]
        prompt = preamble + step_file.read_text()
        timeout_s = self._step_timeout()
        out_path = self._phase_dir / f"step{step_num}-output.json"
        log_path = self._phase_dir / "logs" / f"step{step_num}-attempt{attempt}.jsonl"

        # 세션은 cwd 기준으로 상대 경로를 해석한다 — 워크트리 cwd를 주면
        # 파일 수정이 워크트리 내부로 격리된다
        env = None
        if cwd is not None:
            # editable install(pip install -e .)은 메인 체크아웃의 절대경로를
            # site-packages(.pth)에 고정하므로, 워크트리에서 테스트를 돌리면
            # 메인 코드가 import된다. PYTHONPATH는 site-packages보다 앞서므로
            # 워크트리 경로를 주입해 자기 코드가 우선하게 한다.
            env = os.environ.copy()
            wt_paths = [str(cwd / "src"), str(cwd)]
            prev = env.get("PYTHONPATH")
            env["PYTHONPATH"] = os.pathsep.join(wt_paths + ([prev] if prev else []))
        proc = subprocess.Popen(
            cmd, cwd=str(cwd) if cwd is not None else self._root, text=True, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        # stderr는 별도 스레드로 흡수 — 파이프 버퍼가 차서 세션이 블로킹되는 것을 막는다
        stderr_chunks = []
        stderr_thread = threading.Thread(
            target=lambda: stderr_chunks.append(proc.stderr.read()), daemon=True)
        stderr_thread.start()

        try:
            # 프롬프트는 stdin으로 전달 — argv로 넘기면 프롬프트가 커질 때 ARG_MAX를 초과한다
            proc.stdin.write(prompt)
            proc.stdin.close()
        except BrokenPipeError:
            pass  # 프로세스가 이미 죽었으면 아래에서 exit code로 처리된다

        returncode, last_line = self._stream_session(
            proc, log_path, self._quiet if quiet is None else quiet, timeout_s)
        stderr_thread.join(timeout=5)
        stderr_text = "".join(stderr_chunks)

        if returncode == -1:
            print(f"\n  WARN: Claude가 {timeout_s}초 타임아웃으로 강제 종료됨")
            output = {
                "step": step_num, "name": step_name, "attempt": attempt,
                "exitCode": -1, "timeout": True,
                "stderr": f"timeout after {timeout_s}s",
            }
            self._write_json(out_path, output)
            return {**output, "parsed": {}}

        if returncode != 0:
            print(f"\n  WARN: Claude가 비정상 종료됨 (code {returncode})")
            if stderr_text:
                print(f"  stderr: {stderr_text[:500]}")

        parsed = parse_cli_result(last_line)
        output = {
            "step": step_num, "name": step_name, "attempt": attempt,
            "exitCode": returncode,
            "session_id": parsed.get("session_id"),
            "cost_usd": parsed.get("total_cost_usd"),
            "usage": parsed.get("usage"),
            "num_turns": parsed.get("num_turns"),
            "is_error": parsed.get("is_error"),
            "subtype": parsed.get("subtype"),
            "structured_output": parsed.get("structured_output"),
            "result_text": parsed.get("result"),
            "stderr": stderr_text[:2000],
        }
        self._write_json(out_path, output)

        return {**output, "parsed": parsed}

    def _stream_session(self, proc, log_path: Path, quiet: bool,
                        deadline_s: int) -> tuple[int, str]:
        """stdout을 줄 단위로 스트리밍한다. 모든 줄을 log_path(JSONL)에 append하고,
        quiet가 아니면 _render_event로 렌더링된 줄만 터미널에 출력한다.

        deadline_s 초과 시 proc.kill() 후 (-1, 마지막 줄)을 반환한다 — 기존
        타임아웃 의미(exitCode -1, timeout: True)를 유지. Popen에는 timeout
        인자가 없으므로 타이머 스레드가 kill해 블로킹된 readline을 EOF로 푼다.
        """
        log_path.parent.mkdir(parents=True, exist_ok=True)
        timed_out = threading.Event()

        def _kill_on_deadline():
            if proc.poll() is None:
                timed_out.set()
                proc.kill()

        watchdog = threading.Timer(deadline_s, _kill_on_deadline)
        watchdog.daemon = True
        watchdog.start()
        last_line = ""
        try:
            with log_path.open("a", encoding="utf-8") as log:
                while True:
                    line = proc.stdout.readline()
                    if not line:
                        break
                    log.write(line if line.endswith("\n") else line + "\n")
                    if line.strip():
                        last_line = line.strip()
                    if not quiet:
                        rendered = self._render_event(line)
                        if rendered is not None:
                            print(rendered, flush=True)
            returncode = proc.wait()
        finally:
            watchdog.cancel()

        if timed_out.is_set():
            return -1, last_line
        return returncode, last_line

    @staticmethod
    def _render_event(line: str) -> Optional[str]:
        """stream-json 이벤트 한 줄 → 사람이 읽을 한 줄.

        assistant 텍스트는 공백 정규화 후 앞 100자, tool_use는 '▸ {tool_name}'.
        type:"result"·파싱 불가·그 외 이벤트는 None (출력 스킵).
        """
        try:
            event = json.loads(line)
        except Exception:
            return None
        if not isinstance(event, dict) or event.get("type") != "assistant":
            return None
        content = (event.get("message") or {}).get("content")
        if not isinstance(content, list):
            return None
        parts = []
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                text = " ".join(str(block.get("text") or "").split())
                if text:
                    parts.append(text[:100])
            elif block.get("type") == "tool_use":
                parts.append(f"▸ {block.get('name') or '?'}")
        return "\n".join(parts) if parts else None

    # --- 헤더 & 검증 ---

    def _print_header(self):
        print(f"\n{'='*60}")
        print(f"  Harness Step Executor")
        print(f"  Phase: {self._phase_name} | Steps: {self._total}")
        if self._auto_push:
            print(f"  Auto-push: enabled")
        print(f"{'='*60}")

    def _check_blockers(self):
        index = self._load_index()
        for s in reversed(index["steps"]):
            if s["status"] == "error":
                print(f"\n  ✗ Step {s['step']} ({s['name']}) failed.")
                print(f"  Error: {s.get('error_message', 'unknown')}")
                print(f"  Fix and reset status to 'pending' to retry.")
                sys.exit(1)
            if s["status"] == "blocked":
                print(f"\n  ⏸ Step {s['step']} ({s['name']}) blocked.")
                print(f"  Reason: {s.get('blocked_reason', 'unknown')}")
                print(f"  Resolve and reset status to 'pending' to retry.")
                sys.exit(2)
            if s["status"] != "pending":
                break

    def _ensure_created_at(self):
        index = self._load_index()
        if "created_at" not in index:
            index["created_at"] = self._stamp()
            self._write_json(self._index_file, index)

    # --- 세션 결과 해석 ---

    @staticmethod
    def _session_outcome(result: dict) -> tuple[Optional[str], dict]:
        """_invoke_claude 결과에서 (status, structured_output)을 뽑는다.

        구조화 출력이 없거나 형태가 어긋나면 (None, {}) — 실패 시도로 처리된다.
        """
        so = (result.get("parsed") or {}).get("structured_output")
        if not isinstance(so, dict):
            return None, {}
        status = so.get("status")
        if status not in ("completed", "error", "blocked", "needs_input"):
            return None, {}
        return status, so

    def _failure_message(self, result: dict, status: Optional[str],
                         so: dict) -> str:
        """실패 시도(error/구조화 출력 부재/타임아웃)의 에러 메시지를 만든다."""
        if result.get("timeout"):
            return (
                f"이전 시도가 {self._step_timeout()}초 타임아웃으로 강제 종료되었다. "
                f"작업 트리에 미완성 변경이 남아있을 수 있으니 git status로 확인한 뒤 이어서 작업하라."
            )
        if status == "error":
            return so.get("error_message") or "에러 사유 미보고"
        subtype = (result.get("parsed") or {}).get("subtype")
        return (
            f"세션이 구조화 결과를 반환하지 않았다 "
            f"(subtype: {subtype or 'unknown'}, exit code: {result.get('exitCode')}). "
            f"작업 트리에 미완성 변경이 남아있을 수 있으니 git status로 확인한 뒤 이어서 작업하라."
        )

    # --- 실행 루프 ---

    def _execute_single_step(self, step: dict, guardrails: str) -> bool:
        """단일 step 실행 (재시도·인터뷰 포함). 완료되면 True, 실패/차단이면 exit."""
        step_num, step_name = step["step"], step["name"]
        done = sum(1 for s in self._load_index()["steps"] if s["status"] == "completed")
        prev_error = None
        doc_refs = self._build_doc_refs(step)
        attempt = 1
        interview_rounds = 0

        while attempt <= self.MAX_RETRIES:
            index = self._load_index()
            step_context = self._build_step_context(index)
            interview_context = self._build_interview_context(index, step_num)
            # 재시도는 항상 fresh — 실패한 세션의 컨텍스트는 오염된 것으로 간주해
            # 폐기하고, 정제된 에러 메시지(prev_error)만 preamble로 넘긴다
            preamble = self._build_preamble(guardrails, doc_refs, step_context,
                                            prev_error, interview_context)

            tag = f"Step {step_num}/{self._total - 1} ({done} done): {step_name}"
            if attempt > 1:
                tag += f" [retry {attempt}/{self.MAX_RETRIES}]"

            # quiet: 스피너만 표시, 스트리밍 렌더링 생략. 아니면 스피너 대신
            # 스트리밍 출력 — 둘을 동시에 켜면 터미널 출력이 깨진다
            if self._quiet:
                indicator = progress_indicator(tag)
            else:
                print(f"  ▶ {tag}")
                indicator = _elapsed_timer()

            with indicator as pi:
                result = self._invoke_claude(step, preamble, attempt=attempt)
            # pi.elapsed는 with 블록의 finally에서 확정되므로 블록 밖에서 읽는다
            elapsed = int(pi.elapsed)

            status, so = self._session_outcome(result)

            self._record_attempt(
                step_num, attempt, result.get("parsed", {}), pi.elapsed,
                timeout=bool(result.get("timeout")),
                exit_code=result.get("exitCode", 0),
                interview=(status == "needs_input"),
            )

            ts = self._stamp()

            if status == "completed":
                index = self._load_index()
                for s in index["steps"]:
                    if s["step"] == step_num:
                        s["status"] = "completed"
                        if so.get("summary"):
                            s["summary"] = so["summary"]
                        s["completed_at"] = ts
                self._write_json(self._index_file, index)
                self._commit_step(step_num, step_name)
                print(f"  ✓ Step {step_num}: {step_name} [{elapsed}s]")
                return True

            if status == "needs_input":
                questions = so.get("questions") or []
                degrade = None
                if not self._stdin_interactive():
                    degrade = "비대화형 실행이라 인터뷰를 진행할 수 없다"
                elif interview_rounds >= self.MAX_INTERVIEW_ROUNDS:
                    degrade = f"인터뷰 한도({self.MAX_INTERVIEW_ROUNDS}회) 초과"
                if degrade is None:
                    interview_rounds += 1
                    qa = self._conduct_interview(step_num, step_name, questions)
                    self._record_interviews(step_num, qa)
                    # 인터뷰는 실패가 아니다 — attempt를 소모하지 않고 재실행
                    continue
                status = "blocked"
                so = {"blocked_reason": self._questions_to_reason(degrade, questions)}

            if status == "blocked":
                reason = so.get("blocked_reason", "")
                index = self._load_index()
                for s in index["steps"]:
                    if s["step"] == step_num:
                        s["status"] = "blocked"
                        if reason:
                            s["blocked_reason"] = reason
                        s["blocked_at"] = ts
                self._write_json(self._index_file, index)
                print(f"  ⏸ Step {step_num}: {step_name} blocked [{elapsed}s]")
                print(f"    Reason: {reason}")
                self._update_top_index("blocked")
                sys.exit(2)

            # 실패 시도: status "error", 구조화 출력 부재, 또는 타임아웃
            err_msg = self._failure_message(result, status, so)

            if attempt < self.MAX_RETRIES:
                prev_error = err_msg
                print(f"  ↻ Step {step_num}: retry {attempt}/{self.MAX_RETRIES} — {err_msg}")
                attempt += 1
            else:
                index = self._load_index()
                for s in index["steps"]:
                    if s["step"] == step_num:
                        s["status"] = "error"
                        s["error_message"] = f"[{self.MAX_RETRIES}회 시도 후 실패] {err_msg}"
                        s["failed_at"] = ts
                self._write_json(self._index_file, index)
                self._commit_step(step_num, step_name)
                print(f"  ✗ Step {step_num}: {step_name} failed after {self.MAX_RETRIES} attempts [{elapsed}s]")
                print(f"    Error: {err_msg}")
                self._update_top_index("error")
                sys.exit(1)

        return False  # unreachable

    # --- 병렬 실행 (워크트리 격리) ---

    def _worktree_attempts(self, step: dict, guardrails: str, runner,
                           wt_path: Path, emit) -> dict:
        """워크트리 안에서 단일 step의 재시도·인터뷰 루프를 돈다 (sys.exit 금지 — 스레드용).

        상태는 세션의 구조화 출력에서 직접 읽고, 완료 시 워크트리 안에서 executor가
        커밋한다. 메인 index에는 시도 메타데이터만 기록한다 (상태 병합은 락 안에서 별도).
        반환: {"status": ...} (+ "summary" | "error_message" | "blocked_reason")
        """
        step_num, step_name = step["step"], step["name"]
        prev_error = None
        doc_refs = self._build_doc_refs(step)
        attempt = 1
        interview_rounds = 0

        while attempt <= self.MAX_RETRIES:
            with self._index_lock:
                index = self._load_index()
                step_context = self._build_step_context(index)
                interview_context = self._build_interview_context(index, step_num)
            # 재시도는 항상 fresh — 순차 경로와 동일한 정책 (_execute_single_step 참고)
            preamble = self._build_preamble(guardrails, doc_refs, step_context,
                                            prev_error, interview_context)

            tag = f"▶ {step_name}"
            if attempt > 1:
                tag += f" [retry {attempt}/{self.MAX_RETRIES}]"
            emit(step_num, tag)

            t0 = time.monotonic()
            result = self._invoke_claude(step, preamble, attempt=attempt,
                                         cwd=wt_path, quiet=True)
            elapsed = time.monotonic() - t0

            status, so = self._session_outcome(result)

            with self._index_lock:
                self._record_attempt(
                    step_num, attempt, result.get("parsed", {}), elapsed,
                    timeout=bool(result.get("timeout")),
                    exit_code=result.get("exitCode", 0),
                    interview=(status == "needs_input"),
                )

            if status == "completed":
                runner.commit_step(step_num, self.FEAT_MSG.format(
                    phase=self._phase_name, num=step_num, name=step_name))
                emit(step_num, f"✓ {step_name} [{int(elapsed)}s]")
                return {"status": "completed", "summary": so.get("summary")}

            if status == "needs_input":
                questions = so.get("questions") or []
                degrade = None
                if not self._stdin_interactive():
                    degrade = "비대화형 실행이라 인터뷰를 진행할 수 없다"
                elif interview_rounds >= self.MAX_INTERVIEW_ROUNDS:
                    degrade = f"인터뷰 한도({self.MAX_INTERVIEW_ROUNDS}회) 초과"
                if degrade is None:
                    interview_rounds += 1
                    qa = self._conduct_interview(step_num, step_name, questions)
                    with self._index_lock:
                        self._record_interviews(step_num, qa)
                    continue
                reason = self._questions_to_reason(degrade, questions)
                emit(step_num, f"⏸ blocked: {reason}")
                return {"status": "blocked", "blocked_reason": reason}

            if status == "blocked":
                reason = so.get("blocked_reason", "")
                emit(step_num, f"⏸ blocked: {reason}")
                return {"status": "blocked", "blocked_reason": reason}

            err_msg = self._failure_message(result, status, so)

            if attempt < self.MAX_RETRIES:
                prev_error = err_msg
                emit(step_num, f"↻ retry {attempt}/{self.MAX_RETRIES} — {err_msg}")
                attempt += 1
            else:
                emit(step_num, f"✗ {step_name} failed after {self.MAX_RETRIES} attempts")
                return {"status": "error",
                        "error_message": f"[{self.MAX_RETRIES}회 시도 후 실패] {err_msg}"}

        return {"status": "error", "error_message": "unreachable"}

    def _merge_parallel_outcome(self, step: dict, runner, wt_path: Path,
                                outcome: dict, emit) -> dict:
        """워크트리 결과를 메인 index에 병합한다 (전 과정을 단일 락 안에서).

        completed면 wt 브랜치 merge 후 2단계 커밋·워크트리 제거. 머지 충돌은
        해당 step error 처리(자동 해소 금지). error/blocked는 워크트리를 보존한다.
        """
        step_num, step_name = step["step"], step["name"]
        with self._index_lock:
            status = outcome["status"]
            error_message = outcome.get("error_message")

            if status == "completed":
                # 병렬 실행 중 메인 index에 쓴 시도 메타데이터가 커밋되지 않은 채
                # 남아 있으면 git이 merge 자체를 거부한다 — 먼저 clean하게 만든다
                self._commit_phase_metadata()
                r = runner.merge(step_num)
                if r.returncode != 0:
                    files = [ln.split("Merge conflict in ", 1)[1].strip()
                             for ln in (r.stdout or "").splitlines()
                             if "Merge conflict in " in ln]
                    status = "error"
                    if files:
                        error_message = (f"머지 충돌 (자동 해소 금지) — "
                                         f"충돌 파일: {', '.join(files)}")
                    else:
                        # 충돌이 아닌 실패(dirty tree 거부 등)를 충돌로 오진하지 않는다
                        detail = ((r.stdout or "") + (r.stderr or "")).strip()[:500]
                        error_message = f"머지 실패 — {detail}"

            ts = self._stamp()
            index = self._load_index()
            for s in index["steps"]:
                if s["step"] == step_num:
                    s["status"] = status
                    if status == "completed":
                        if outcome.get("summary"):
                            s["summary"] = outcome["summary"]
                        s["completed_at"] = ts
                    elif status == "blocked":
                        if outcome.get("blocked_reason"):
                            s["blocked_reason"] = outcome["blocked_reason"]
                        s["blocked_at"] = ts
                    elif status == "error":
                        s["error_message"] = error_message or "unknown"
                        s["failed_at"] = ts
                    break
            self._write_json(self._index_file, index)

            if status == "completed":
                self._commit_step(step_num, step_name)
                runner.remove(step_num)
            else:
                # 사람이 검사할 수 있게 워크트리를 보존하고 경로를 알린다
                emit(step_num, f"{status} — 워크트리 보존: {wt_path}")

        return {"step": step_num, "status": status, "wt_path": wt_path}

    def _run_parallel_step(self, step: dict, guardrails: str, runner, emit) -> dict:
        step_num = step["step"]
        with self._index_lock:
            index = self._load_index()
            for s in index["steps"]:
                if s["step"] == step_num and "started_at" not in s:
                    s["started_at"] = self._stamp()
                    self._write_json(self._index_file, index)
                    break
            # git worktree add도 메인 repo 메타데이터를 만지므로 직렬화한다
            wt_path = runner.create(step_num)
        outcome = self._worktree_attempts(step, guardrails, runner, wt_path, emit)
        return self._merge_parallel_outcome(step, runner, wt_path, outcome, emit)

    def _execute_parallel_batch(self, ready: list, guardrails: str):
        """ready step들을 워크트리 격리로 동시 실행한다.

        blocked가 나오면 아직 시작하지 않은 step 제출을 취소하고, 진행 중인
        것만 완료를 기다린 뒤 exit 2. error가 있으면 exit 1 (blocked 우선).
        """
        print_lock = threading.Lock()

        def emit(step_num, msg):
            with print_lock:
                print(f"  [step {step_num}] {msg}", flush=True)

        runner = WorktreeRunner(Path(self._root), self._phase_dir_name,
                                f"feat-{self._phase_name}")
        outcomes = []
        with ThreadPoolExecutor(max_workers=self._parallel) as pool:
            futures = {
                pool.submit(self._run_parallel_step, s, guardrails, runner, emit): s
                for s in ready
            }
            for fut in as_completed(futures):
                if fut.cancelled():
                    continue
                s = futures[fut]
                try:
                    outcome = fut.result()
                except Exception as e:
                    emit(s["step"], f"✗ 병렬 실행 예외: {e}")
                    outcome = {"step": s["step"], "status": "error",
                               "error_message": str(e)}
                outcomes.append(outcome)
                if outcome.get("status") == "blocked":
                    for other in futures:
                        other.cancel()

        statuses = [o.get("status") for o in outcomes]
        if "blocked" in statuses:
            self._update_top_index("blocked")
            sys.exit(2)
        if "error" in statuses:
            self._update_top_index("error")
            sys.exit(1)

    def _execute_all_steps(self, guardrails: str):
        while True:
            index = self._load_index()
            if not any(s["status"] == "pending" for s in index["steps"]):
                print("\n  All steps completed!")
                return

            ready = self._ready_steps(index)
            if not ready:
                # pending은 남았는데 실행 가능한 step이 없다 — 의존 step이
                # blocked/error에 걸려 있는 상태. 계속 돌면 무한 루프가 된다.
                print("\n  의존성 교착 상태 — blocked/error 상태의 선행 step을 해결하라")
                sys.exit(1)

            # ready가 1개뿐이면 워크트리 오버헤드 없이 기존 순차 경로를 쓴다
            if self._parallel > 1 and len(ready) >= 2:
                self._execute_parallel_batch(ready, guardrails)
                continue

            step = ready[0]
            step_num = step["step"]
            for s in index["steps"]:
                if s["step"] == step_num and "started_at" not in s:
                    s["started_at"] = self._stamp()
                    self._write_json(self._index_file, index)
                    break

            self._execute_single_step(step, guardrails)

    def _finalize(self):
        index = self._load_index()
        index["completed_at"] = self._stamp()

        # 과거 phase처럼 메트릭 필드가 없는 index에는 totals 키 자체를 만들지 않는다
        costs = [s["cost_usd"] for s in index["steps"]
                 if isinstance(s.get("cost_usd"), (int, float))]
        durations = [s["duration_s"] for s in index["steps"]
                     if isinstance(s.get("duration_s"), (int, float))]
        if costs:
            index["total_cost_usd"] = round(sum(costs), 6)
        if durations:
            index["total_duration_s"] = round(sum(durations), 1)

        self._write_json(self._index_file, index)
        self._update_top_index("completed")

        # 리포트는 아래 git 커밋보다 먼저 생성해 "mark phase completed" 커밋에 포함시킨다
        (self._phase_dir / "report.md").write_text(
            generate_report(index), encoding="utf-8")

        self._run_git("add", "-A")
        if self._run_git("diff", "--cached", "--quiet").returncode != 0:
            msg = f"chore({self._phase_name}): mark phase completed"
            r = self._run_git("commit", "-m", msg)
            if r.returncode == 0:
                print(f"  ✓ {msg}")

        if self._auto_push:
            branch = f"feat-{self._phase_name}"
            r = self._run_git("push", "-u", "origin", branch)
            if r.returncode != 0:
                print(f"\n  ERROR: git push 실패: {r.stderr.strip()}")
                sys.exit(1)
            print(f"  ✓ Pushed to origin/{branch}")

        print(f"\n{'='*60}")
        print(f"  Phase '{self._phase_name}' completed!")
        print(f"{'='*60}")


def main():
    parser = argparse.ArgumentParser(description="Harness Step Executor")
    parser.add_argument("phase_dir", help="Phase directory name (e.g. 0-mvp)")
    parser.add_argument("--push", action="store_true", help="Push branch after completion")
    parser.add_argument("--quiet", action="store_true",
                        help="스트리밍 출력 대신 스피너만 표시 (이벤트 로그 파일은 항상 기록)")
    parser.add_argument("--parallel", type=int, default=1, metavar="N",
                        help="동시 실행 step 수 (의존성 없는 step들을 워크트리 격리로 병렬 실행)")
    args = parser.parse_args()

    StepExecutor(args.phase_dir, auto_push=args.push, quiet=args.quiet,
                 parallel=args.parallel).run()


if __name__ == "__main__":
    main()
