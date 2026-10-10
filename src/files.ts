import type { Agent } from './config.js';
import { quote, remotePath, runRemote } from './ssh.js';

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  hasChildren: boolean;
}

export interface WorkspaceFileListing {
  path: string;
  entries: WorkspaceFileEntry[];
  truncated: boolean;
  repository: boolean;
}

export interface WorkspaceFileContent {
  path: string;
  revision: string;
  size: number;
  changed: boolean;
  content?: string;
}

const listMarker = '__AGENT_HUB_FILES__';
const contentMarker = '__AGENT_HUB_FILE__';
const maxFileBytes = 1024 * 1024;

export function validWorkspacePath(path: string, allowEmpty = false) {
  return (allowEmpty || !!path) && path.length <= 4096 && !path.includes('\0') && !path.includes('\n') && !path.includes('\r') && !path.startsWith('/') && !path.split('/').includes('..');
}

function environment(agent: Agent, cwd: string) {
  const initScript = agent.initScript ?? '';
  const initialize = initScript.trim() ? `set -e\neval ${quote(initScript)} </dev/null\n` : '';
  return `${initialize}cd ${remotePath(cwd)}\n`;
}

function pythonCommand(source: string, args: string[]) {
  const encoded = Buffer.from(source).toString('base64');
  return `python3 -c "import base64;exec(base64.b64decode('${encoded}'))" ${args.map(quote).join(' ')}`;
}

const listSource = String.raw`import json,os,subprocess,sys
root=os.path.realpath(os.path.expanduser(sys.argv[1]))
relative=sys.argv[2]
query=sys.argv[3].casefold().strip()
requested=os.path.realpath(os.path.join(root,relative))
if os.path.commonpath([root,requested]) != root: raise ValueError("文件路径超出工作区")
if not os.path.isdir(requested): raise ValueError("目录不存在或不可访问")
def git(args,cwd=root,input=None):
 try: return subprocess.run(["git",*args],cwd=cwd,input=input,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,check=True).stdout
 except (OSError,subprocess.CalledProcessError): return None
repo_raw=git(["rev-parse","--show-toplevel"])
repo=os.path.realpath(repo_raw.decode().strip()) if repo_raw else None
repository=bool(repo and os.path.commonpath([repo,root]) == repo)
def inside(path):
 try: return os.path.commonpath([root,os.path.realpath(path)]) == root
 except (OSError,ValueError): return False
def visible(entries):
 if not repository or not entries: return entries
 paths=[]
 for item in entries:
  absolute=os.path.join(root,item["path"])
  paths.append(os.path.relpath(absolute,repo))
 ignored=git(["check-ignore","-z","--stdin"],repo,("\0".join(paths)+"\0").encode()) or b""
 ignored_set={item.decode() for item in ignored.split(b"\0") if item}
 return [item for item,path in zip(entries,paths) if path not in ignored_set]
entries=[]
limit=200 if query else 300
if query and repository:
 prefix=os.path.relpath(root,repo)
 pathspec="." if prefix == "." else prefix
 raw=git(["ls-files","--cached","--others","--exclude-standard","-z","--",pathspec],repo) or b""
 for value in raw.split(b"\0"):
  if not value: continue
  absolute=os.path.join(repo,os.fsdecode(value))
  if not inside(absolute) or not os.path.isfile(absolute): continue
  path=os.path.relpath(absolute,root)
  if query in path.casefold(): entries.append({"name":os.path.basename(path),"path":path,"type":"file","hasChildren":False})
  if len(entries)>limit: break
elif query:
 for base,dirs,files in os.walk(root,followlinks=False):
  dirs[:]=[name for name in dirs if name != ".git" and inside(os.path.join(base,name))]
  for name in files:
   absolute=os.path.join(base,name)
   if not inside(absolute): continue
   path=os.path.relpath(absolute,root)
   if query in path.casefold(): entries.append({"name":name,"path":path,"type":"file","hasChildren":False})
   if len(entries)>limit: break
  if len(entries)>limit: break
else:
 with os.scandir(requested) as scan:
  for entry in scan:
   if entry.name == ".git" or not inside(entry.path): continue
   try:
    directory=entry.is_dir(follow_symlinks=True)
    regular=entry.is_file(follow_symlinks=True)
    if not directory and not regular: continue
    path=os.path.relpath(entry.path,root)
    entries.append({"name":entry.name,"path":path,"type":"directory" if directory else "file","hasChildren":directory})
   except OSError: pass
 entries=visible(entries)
 entries.sort(key=lambda item:(item["type"] != "directory",item["name"].startswith("."),item["name"].casefold()))
if query: entries.sort(key=lambda item:item["path"].casefold())
truncated=len(entries)>limit
entries=entries[:limit]
print("${listMarker}"+json.dumps({"path":relative,"entries":entries,"truncated":truncated,"repository":repository},ensure_ascii=False))`;

const contentSource = String.raw`import json,os,sys
root=os.path.realpath(os.path.expanduser(sys.argv[1]))
relative=sys.argv[2]
known=sys.argv[3]
absolute=os.path.realpath(os.path.join(root,relative))
if os.path.commonpath([root,absolute]) != root: raise ValueError("文件路径超出工作区")
if not os.path.isfile(absolute): raise ValueError("文件不存在或不可读取")
stat=os.stat(absolute)
revision=f"{stat.st_mtime_ns:x}-{stat.st_size:x}"
if known and known == revision:
 print("${contentMarker}"+json.dumps({"path":relative,"revision":revision,"size":stat.st_size,"changed":False},ensure_ascii=False))
else:
 if stat.st_size > ${maxFileBytes}: raise ValueError("文件超过 1 MiB，无法在审阅器中打开")
 with open(absolute,"rb") as source: data=source.read(${maxFileBytes + 1})
 if len(data) > ${maxFileBytes}: raise ValueError("文件超过 1 MiB，无法在审阅器中打开")
 if b"\0" in data: raise ValueError("该文件不是可审阅的文本文件")
 try: content=data.decode("utf-8")
 except UnicodeDecodeError: raise ValueError("该文件不是有效的 UTF-8 文本")
 print("${contentMarker}"+json.dumps({"path":relative,"revision":revision,"size":len(data),"changed":True,"content":content},ensure_ascii=False))`;

function parseMarked<T>(output: string, marker: string, error: string): T {
  const index = output.lastIndexOf(marker);
  if (index < 0) throw new Error(error);
  return JSON.parse(output.slice(index + marker.length).trim()) as T;
}

export async function listWorkspaceFiles(agent: Agent, cwd: string, path = '', query = '', run = runRemote): Promise<WorkspaceFileListing> {
  if (!validWorkspacePath(path, true) || query.length > 200 || query.includes('\0') || query.includes('\n') || query.includes('\r')) throw new Error('文件查询无效');
  const command = `${environment(agent, cwd)}# ${listMarker}\n${pythonCommand(listSource, [cwd, path, query])}`;
  return parseMarked(await run(agent, command, ''), listMarker, '文件列表返回格式无效');
}

export async function readWorkspaceFile(agent: Agent, cwd: string, path: string, revision = '', run = runRemote): Promise<WorkspaceFileContent> {
  if (!validWorkspacePath(path) || revision.length > 200 || revision.includes('\0') || revision.includes('\n') || revision.includes('\r')) throw new Error('文件路径无效');
  const command = `${environment(agent, cwd)}# ${contentMarker}\n${pythonCommand(contentSource, [cwd, path, revision])}`;
  return parseMarked(await run(agent, command, ''), contentMarker, '文件读取返回格式无效');
}
