#!/usr/bin/env python3
"""Run a bounded, observable review through the personal Claude reviewer agent."""
import argparse, json, os, signal, subprocess, sys, tempfile, threading, time
from pathlib import Path

SCHEMA={"type":"object","required":["verdict","summary","findings","verified"],"properties":{"verdict":{"enum":["PASS","NEEDS_WORK"]},"summary":{"type":"string"},"findings":{"type":"array","items":{"type":"object","required":["severity","confidence","file","line","title","evidence","recommendation"],"properties":{"severity":{"enum":["critical","high","medium"]},"confidence":{"type":"integer","minimum":80,"maximum":100},"file":{"type":"string"},"line":{"type":["integer","null"]},"title":{"type":"string"},"evidence":{"type":"string"},"recommendation":{"type":"string"}},"additionalProperties":False}},"verified":{"type":"array","items":{"type":"string"}}},"additionalProperties":False}

def git(repo,*args):
    result=subprocess.run(["git","-C",str(repo),*args],text=True,capture_output=True)
    if result.returncode: raise RuntimeError(result.stderr.strip() or "git command failed")
    return result.stdout

def resolve(repo,revision): return git(repo,"rev-parse","--verify",f"{revision}^{{commit}}").strip()

def make_packet(repo,base,head,spec,evidence):
    instructions=[]
    for name in ("AGENTS.md","CLAUDE.md"):
        path=repo/name
        if path.is_file(): instructions.append(f"## {name}\n\n{path.read_text(errors='replace')}")
    diff=git(repo,"diff","--no-ext-diff","--find-renames",base,head); limit=1_000_000
    if len(diff)>limit: diff=diff[:limit]+f"\n[diff clipped after {limit} characters; inspect repository for remainder]\n"
    return "\n".join(["# Immutable external review packet",f"Repository: {repo}",f"Base commit: {base}",f"Head commit: {head}","\n## Requested behavior\n"+(spec or "Not supplied."),"\n## Builder evidence\n"+(evidence or "Not supplied."),"\n## Change summary\n"+git(repo,"diff","--stat",base,head),"\n## Changed paths\n"+git(repo,"diff","--name-status",base,head),"\n## Repository instructions\n"+("\n\n".join(instructions) or "None at root."),"\n## Diff\n```diff\n"+diff+"\n```"])

def normalize(payload):
    if isinstance(payload,dict) and "structured_output" in payload: payload=payload["structured_output"]
    elif isinstance(payload,dict) and isinstance(payload.get("result"),str):
        try: payload=json.loads(payload["result"])
        except json.JSONDecodeError: raise ValueError("provider result was not the required JSON object")
    if not isinstance(payload,dict) or not {"verdict","summary","findings","verified"}.issubset(payload): raise ValueError("missing result fields")
    findings=payload["findings"]
    if not isinstance(findings,list): raise ValueError("findings must be a list")
    if any(not isinstance(f,dict) or not isinstance(f.get("confidence"),int) or f["confidence"]<80 for f in findings): raise ValueError("finding confidence must be >= 80")
    if payload["verdict"]=="PASS" and findings: raise ValueError("PASS cannot include findings")
    if payload["verdict"]=="NEEDS_WORK" and not findings: raise ValueError("NEEDS_WORK requires findings")
    if payload["verdict"] not in {"PASS","NEEDS_WORK"}: raise ValueError("invalid verdict")
    return payload

def self_test():
    normalize({"verdict":"PASS","summary":"ok","findings":[],"verified":[]})
    normalize({"verdict":"NEEDS_WORK","summary":"issue","findings":[{"confidence":80}],"verified":[]})
    try: normalize({"verdict":"PASS","summary":"bad","findings":[{"confidence":90}],"verified":[]})
    except ValueError: print("PASS"); return 0
    return 2

def main():
    p=argparse.ArgumentParser(); p.add_argument("--repo",default="."); p.add_argument("--base"); p.add_argument("--head",default="HEAD"); p.add_argument("--spec",default=""); p.add_argument("--evidence",default=""); p.add_argument("--timeout",type=int,default=600); p.add_argument("--heartbeat",type=float,default=15); p.add_argument("--output-dir"); p.add_argument("--claude",default=os.environ.get("EXTERNAL_REVIEW_CLAUDE","claude")); p.add_argument("--self-test",action="store_true"); a=p.parse_args()
    if a.self_test: return self_test()
    if not a.base: p.error("--base is required")
    try:
        repo=Path(git(Path(a.repo),"rev-parse","--show-toplevel").strip()); base=resolve(repo,a.base); head=resolve(repo,a.head)
        out=Path(a.output_dir) if a.output_dir else Path(tempfile.mkdtemp(prefix="external-review-")); out.mkdir(parents=True,exist_ok=True)
        packet=out/"packet.md"; packet.write_text(make_packet(repo,base,head,a.spec,a.evidence)); raw=out/"raw.json"
        prompt=f"Review the immutable packet at {packet}. Inspect {repo} as needed. Return only the required structured verdict."
        command=[a.claude,"--agent","reviewer","-p",prompt,"--output-format","json","--json-schema",json.dumps(SCHEMA,separators=(",",":")),"--setting-sources","user","--strict-mcp-config","--permission-mode","dontAsk","--no-session-persistence","--add-dir",str(out)]
        print(f"external-review: {base[:12]}..{head[:12]} (timeout {a.timeout}s)",file=sys.stderr,flush=True)
        process=subprocess.Popen(command,cwd=repo,stdout=subprocess.PIPE,stderr=None,text=True,start_new_session=True)
        stop=threading.Event()
        def beat():
            started=time.monotonic()
            while not stop.wait(a.heartbeat): print(f"external-review: reviewer still running ({int(time.monotonic()-started)}s)",file=sys.stderr,flush=True)
        thread=threading.Thread(target=beat,daemon=True); thread.start()
        try: stdout,_=process.communicate(timeout=a.timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid,signal.SIGTERM)
            try: stdout,_=process.communicate(timeout=5)
            except subprocess.TimeoutExpired: os.killpg(process.pid,signal.SIGKILL); stdout,_=process.communicate()
            raw.write_text(stdout or ""); print(f"external-review: TIMEOUT; artifacts: {out}",file=sys.stderr); return 124
        finally: stop.set(); thread.join(timeout=1)
        raw.write_text(stdout or "")
        if process.returncode: print(f"external-review: REVIEWER_ERROR ({process.returncode}); artifacts: {out}",file=sys.stderr); return 2
        result=normalize(json.loads(stdout)); (out/"verdict.json").write_text(json.dumps(result,indent=2)+"\n"); print(json.dumps(result)); print(f"external-review: {result['verdict']}; artifacts: {out}",file=sys.stderr); return 0 if result["verdict"]=="PASS" else 1
    except (OSError,RuntimeError,ValueError,json.JSONDecodeError) as error: print(f"external-review: REVIEWER_ERROR: {error}",file=sys.stderr); return 2

if __name__=="__main__": raise SystemExit(main())
