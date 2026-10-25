import {readFile,mkdir,writeFile}from'node:fs/promises';
import{createHash}from'node:crypto';
import{join}from'node:path';
import{MemoryStore,serializeMemory}from'../../src/store.ts';
const sha=text=>createHash('sha256').update(text).digest('hex');
export async function addPollution(root,projectKey){
 const text=await readFile(new URL('./pollution.json',import.meta.url),'utf8'),fixture=JSON.parse(text),scope=`project:${projectKey}`,directory=join(root,'projects',sha(projectKey).slice(0,24),'items');
 await mkdir(directory,{recursive:true});const memories=[];
 for(let i=0;i<fixture.count;i++){
  const domain=fixture.domains[i%fixture.domains.length],subject=fixture.subjects[Math.floor(i/fixture.domains.length)%fixture.subjects.length],key=`pollution-v1:${projectKey}:${i}`,title=`${domain} ${subject} detail ${i}`,body=`For ${domain} subsystem ${i}, inspect ${subject} diagnostic marker ${i} before changing configuration. This record is specific to component ${i}.`,source={session:'synthetic:pollution-v1',entries:[`noise-${i}`],origin:'user_confirmation'};
  memories.push({id:`m_${sha(key).slice(0,28)}`,type:'project',scope,title,body,summary:body,keywords:[domain,subject,`component${i}`],triggers:[],paths:[],importance:3+i%5,confidence:.95,source,sources:[source],supersedes:[],links:[],status:'active',retention:'long',created:fixture.timestamp,updated:fixture.timestamp,last_used:fixture.timestamp,stats:{injected:0,used:0,helpful:0,harmful:0}});
 }
 for(let offset=0;offset<memories.length;offset+=64)await Promise.all(memories.slice(offset,offset+64).map(memory=>writeFile(join(directory,`${memory.id}.md`),serializeMemory(memory),{mode:0o600,flag:'wx'})));
 const store=new MemoryStore(root,projectKey);await store.initialize();await store.reindex();store.close();
 return{fixtureHash:sha(text),count:memories.length,scope,ids:memories.map(memory=>memory.id)};
}
