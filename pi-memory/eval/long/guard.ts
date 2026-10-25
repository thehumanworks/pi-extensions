import { readFileSync, writeFileSync, appendFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

const quote=(text:string)=>`'${text.replace(/'/g,"'\\''")}'`;
export default function(pi:any){
  const log=(value:any)=>{if(process.env.PI_LONG_ACTION_TRACE)appendFileSync(process.env.PI_LONG_ACTION_TRACE,JSON.stringify({at:new Date().toISOString(),phase:process.env.PI_LONG_CALL_NAME,...value})+'\n');};
  pi.on('before_provider_request',(event:any)=>{
    const path=process.env.PI_LONG_BUDGET!;
    let budget={requests:0};if(existsSync(path))budget=JSON.parse(readFileSync(path,'utf8'));
    if(budget.requests>=Number(process.env.PI_LONG_MAX_REQUESTS??24)){log({event:'budget_exhausted',...budget});process.exit(86);}
    budget.requests++;writeFileSync(path,JSON.stringify(budget));
    const payload={...event.payload};if('input'in payload)payload.max_output_tokens=3072;else payload.max_tokens=3072;
    log({event:'model_request',number:budget.requests,outputCap:3072});return payload;
  });
  pi.on('tool_call',(event:any,ctx:any)=>{
    const root=realpathSync(ctx.cwd),input=event.input??{};
    const allowed=(path:string)=>{
      const absolute=resolve(root,path);let parent=absolute;
      while(!existsSync(parent)&&parent!==dirname(parent))parent=dirname(parent);
      const actual=resolve(realpathSync(parent),absolute.slice(parent.length).replace(/^[/\\]+/,''));
      return actual===root||actual.startsWith(root+sep);
    };
    if(['read','write','edit','ls','find','grep'].includes(event.toolName)&&typeof input.path==='string'&&!allowed(input.path)){
      log({event:'blocked_path',tool:event.toolName,input});return{block:true,reason:'This benchmark permits files only inside the synthetic project.'};
    }
    if(event.toolName==='bash'){
      const command=String(input.command??'').trim();
      const match=/^(?:(INGEST_ORDER=tenant-first|MIGRATION_LOCK_MODE=copy) )?node (.+)$/.exec(command);
      const args=match?.[2]??'';
      if(!match||!/^[A-Za-z0-9_./*=: -]+$/.test(args)||args.includes('..')||args.split(/\s+/).some((arg:string)=>isAbsolute(arg)||/^--(?:allow|import|require|eval|experimental)/.test(arg))||!(args==='--test'||args.startsWith('--test ')||/^(?:bin|tools|test)\/[A-Za-z0-9_./-]+\.mjs(?: |$)/.test(args))){
        log({event:'blocked_command',command});return{block:true,reason:'Use node --test or node bin|tools|test/relative-script.mjs with simple relative arguments. Use read/write/edit for files; no shell chains or redirects.'};
      }
      const testFlag=args.startsWith('--test')&&!args.includes('--test-isolation=')?'--test-isolation=none ':'';
      input.command=`env -i PATH=/usr/bin:/bin ${match[1]??''} ${quote(process.env.PI_LONG_NODE!)} --permission --allow-fs-read=${quote(root)} --allow-fs-write=${quote(root)} ${testFlag}${args}`;
      input.timeout=Math.min(Number(input.timeout??30),30);
    }
    log({event:'tool_call',tool:event.toolName,id:event.toolCallId,input});
  });
  pi.on('tool_execution_end',(event:any)=>log({event:'tool_end',tool:event.toolName,id:event.toolCallId,isError:event.isError,durationMs:event.durationMs,result:event.result}));
  pi.on('agent_settled',(event:any)=>log({event:'settled',aborted:event.aborted}));
}
