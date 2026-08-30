#!/usr/bin/env python3
"""Run a bounded, observable review through an isolated provider adapter."""
import argparse, json, os, signal, subprocess, sys, tempfile, threading, time
import re
from pathlib import Path

SCHEMA={"type":"object","required":["verdict","summary","findings","verified"],"properties":{"verdict":{"enum":["PASS","NEEDS_WORK"]},"summary":{"type":"string"},"findings":{"type":"array","items":{"type":"object","required":["severity","confidence","file","line","title","evidence","recommendation"],"properties":{"severity":{"enum":["critical","high","medium"]},"confidence":{"type":"integer","minimum":80,"maximum":100},"file":{"type":"string"},"line":{"type":["integer","null"]},"title":{"type":"string"},"evidence":{"type":"string"},"recommendation":{"type":"string"}},"additionalProperties":False}},"verified":{"type":"array","items":{"type":"string"}}},"additionalProperties":False}

def worker_policy():
    path=Path(__file__).resolve().with_name("external-review.md")
    return path.read_text(errors="replace")

def provider_command(a,repo,out,packet,prompt):
    policy=worker_policy()
    if a.provider=="claude":
        return [a.claude,"-p",prompt,"--system-prompt",policy,"--output-format","json",
                "--json-schema",json.dumps(SCHEMA,separators=(",",":")),"--safe-mode",
                "--restricted","--tools","Read,Grep,Glob","--permission-mode","dontAsk",
                "--no-session-persistence","--strict-mcp-config","--add-dir",str(out)],None
    schema=out/"schema.json"; schema.write_text(json.dumps(SCHEMA))
    answer=out/"provider-output.json"
    return [a.codex,"exec","--ephemeral","--ignore-user-config","--ignore-rules",
            "--sandbox","read-only","--cd",str(repo),"--output-schema",str(schema),
            "--output-last-message",str(answer),f"{policy}\n\n{prompt}"],answer

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
        result=payload["result"].strip()
        fenced=re.fullmatch(r"```(?:json)?\s*(\{.*\})\s*```",result,re.S)
        if fenced: result=fenced.group(1)
        try: payload=json.loads(result)
        except json.JSONDecodeError: raise ValueError("provider result was not the required JSON object")
    required={"verdict","summary","findings","verified"}
    if not isinstance(payload,dict) or not required.issubset(payload): raise ValueError("missing result fields")
    if set(payload)!=required: raise ValueError("unexpected result fields")
    if not isinstance(payload["summary"],str): raise ValueError("summary must be a string")
    if not isinstance(payload["verified"],list) or any(not isinstance(v,str) for v in payload["verified"]): raise ValueError("verified must be a list of strings")
    findings=payload["findings"]
    if not isinstance(findings,list): raise ValueError("findings must be a list")
    finding_fields={"severity","confidence","file","line","title","evidence","recommendation"}
    for finding in findings:
        if not isinstance(finding,dict) or set(finding)!=finding_fields: raise ValueError("finding fields are malformed")
        confidence=finding["confidence"]
        if isinstance(confidence,bool) or not isinstance(confidence,int) or not 80<=confidence<=100: raise ValueError("finding confidence must be 80 through 100")
        if finding["severity"] not in {"critical","high","medium"}: raise ValueError("finding severity is invalid")
        if isinstance(finding["line"],bool) or not (finding["line"] is None or isinstance(finding["line"],int)): raise ValueError("finding line must be an integer or null")
        if any(not isinstance(finding[name],str) for name in ("file","title","evidence","recommendation")): raise ValueError("finding text fields must be strings")
    if payload["verdict"]=="PASS" and findings: raise ValueError("PASS cannot include findings")
    if payload["verdict"]=="NEEDS_WORK" and not findings: raise ValueError("NEEDS_WORK requires findings")
    if payload["verdict"] not in {"PASS","NEEDS_WORK"}: raise ValueError("invalid verdict")
    return payload

def self_test():
    normalize({"verdict":"PASS","summary":"ok","findings":[],"verified":[]})
    finding={"severity":"medium","confidence":80,"file":"x","line":None,"title":"issue","evidence":"proof","recommendation":"fix"}
    normalize({"verdict":"NEEDS_WORK","summary":"issue","findings":[finding],"verified":[]})
    try: normalize({"verdict":"PASS","summary":"bad","findings":[finding],"verified":[]})
    except ValueError: print("PASS"); return 0
    return 2

def main():
    p=argparse.ArgumentParser(); p.add_argument("--repo",default="."); p.add_argument("--base"); p.add_argument("--head",default="HEAD"); spec=p.add_mutually_exclusive_group(); spec.add_argument("--spec",default=""); spec.add_argument("--spec-file"); p.add_argument("--evidence",default=""); p.add_argument("--timeout",type=int,default=600); p.add_argument("--heartbeat",type=float,default=15); p.add_argument("--output-dir"); p.add_argument("--provider",choices=("claude","codex"),default=os.environ.get("ATELIER_REVIEW_PROVIDER","claude")); p.add_argument("--claude",default=os.environ.get("EXTERNAL_REVIEW_CLAUDE","claude")); p.add_argument("--codex",default=os.environ.get("EXTERNAL_REVIEW_CODEX","codex")); p.add_argument("--self-test",action="store_true"); a=p.parse_args()
    if a.self_test: return self_test()
    if not a.base: p.error("--base is required")
    try:
        repo=Path(git(Path(a.repo),"rev-parse","--show-toplevel").strip()); base=resolve(repo,a.base); head=resolve(repo,a.head)
        requested=Path(a.spec_file).read_text(errors="replace") if a.spec_file else a.spec
        out=Path(a.output_dir) if a.output_dir else Path(tempfile.mkdtemp(prefix="external-review-")); out.mkdir(parents=True,exist_ok=True)
        packet=out/"packet.md"; packet.write_text(make_packet(repo,base,head,requested,a.evidence)); raw=out/"raw.json"
        prompt=f"Review the immutable packet at {packet}. Inspect {repo} as needed. Return only the required structured verdict."
        command,answer=provider_command(a,repo,out,packet,prompt)
        print(f"external-review: {a.provider} {base[:12]}..{head[:12]} (timeout {a.timeout}s)",file=sys.stderr,flush=True)
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
        if answer and answer.is_file(): stdout=answer.read_text(errors="replace")
        raw.write_text(stdout or "")
        if process.returncode: print(f"external-review: REVIEWER_ERROR ({process.returncode}); artifacts: {out}",file=sys.stderr); return 2
        result=normalize(json.loads(stdout)); (out/"verdict.json").write_text(json.dumps(result,indent=2)+"\n"); print(json.dumps(result)); print(f"external-review: {result['verdict']}; artifacts: {out}",file=sys.stderr); return 0 if result["verdict"]=="PASS" else 1
    except (OSError,RuntimeError,ValueError,json.JSONDecodeError) as error: print(f"external-review: REVIEWER_ERROR: {error}",file=sys.stderr); return 2

if __name__=="__main__": raise SystemExit(main())
