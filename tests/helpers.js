'use strict';
const C=require('../src/Core.js');
const crypto=require('node:crypto');
const key='11111111-1111-4111-8111-111111111111';
const labels=[...['INBOX','UNREAD','SPAM','IMPORTANT','STARRED','TRASH'].map(id=>({id,name:id,type:'system'})),{id:'Label_1',name:'仕事',type:'user'}];
const base=()=>({id:'old',criteria:{from:'sender@example.com'},action:{removeLabelIds:['INBOX']}});
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const clone=C.clone;
function harness(options={}) {
  const data={filters:clone(options.filters||[base()]),labels:clone(labels),forwarding:[{forwardingEmail:'dest@example.com',verificationStatus:'accepted'}]};
  const rows=clone(options.rows===undefined?[C.importFilter(base(),labels,key)]:options.rows);
  const labelRows=clone(options.labelRows||[]);
  const props={},backups={},scopes={},history=[],writes=[],diffs=[];
  let serial=0,time=0;
  const faults={};
  const fail=name=>{if(faults[name]){const f=faults[name];delete faults[name];if(typeof f==='function')f();else throw new Error(name+' failed');}};
  const views=new Map();let viewSerial=0;
  const store={
    writeWebView(id,value){const p={runId:"webview-"+id,id:id+"-"+(++viewSerial)};views.set(p.id,clone(value));return p;},
    readWebView(p){if(!views.has(p.id))throw Error("missing view");return clone(views.get(p.id));},
    removeWebView(p){views.delete(p.id);},
    ensureLabelSchema(){},
    readLabelRows(){fail('readLabelRows');return clone(labelRows);},
    ensureLabelKeys(uuid){labelRows.forEach(r=>{if(!r.LabelKey)r.LabelKey=uuid();});},
    appendLabelRows(rs){labelRows.push(...clone(rs));},
    updateLabelRow(k,patch){fail('updateLabelRow');const found=labelRows.filter(r=>r.LabelKey===k);if(found.length!==1)throw Error('LabelKey missing/duplicate');Object.assign(found[0],clone(patch));},
    setFilterLabel(k,expected,ref){fail('setFilterLabel');const found=rows.filter(r=>r.RuleKey===k);if(found.length!==1||C.stable(C.config(found))!==C.stable(C.config([expected])))throw Error('filter changed');found[0].UserLabelRef=ref?JSON.stringify(ref):'';if(ref)found[0].UserLabel=ref.name;},
    ensureKeys(uuid){rows.forEach(r=>{if(!r.RuleKey)r.RuleKey=uuid();});},
    readRows(){fail('readRows');return clone(rows);},
    appendRows(rs){for(const r of rs){fail('appendRows');rows.push(clone(r));}},
    updateRow(k,patch){fail('updateRow');const found=rows.filter(r=>r.RuleKey===k);if(found.length!==1)throw new Error('RuleKey missing/duplicate');Object.assign(found[0],clone(patch));},
    writeDiff(run,entries){diffs.push({run,entries:clone(entries)});},
    backup(state,id,date){fail('backup');backups[id]=clone(state);return {id,hash:hash(C.stable(C.remote(state))),count:state.filters.length};},
    readBackup(id){if(!backups[id])throw new Error('snapshot missing');return clone(backups[id]);},
    writeScope(id,keys){if(scopes[id])throw new Error('scope exists');scopes[id]=clone(keys);},
    readScope(id){if(!scopes[id])throw new Error('scope missing');return clone(scopes[id]);},
    history(e){fail('history');history.push(clone(e));}
  };
  const gmail={
    read(){fail('read');return clone(data);},
    createLabel(name){fail('createLabel');const result={id:'label-new-'+(++serial),name,type:'user'};data.labels.push(result);writes.push(['labelCreate',result.id]);fail('afterCreateLabel');return clone(result);},
    renameLabel(id,name){fail('renameLabel');const found=data.labels.find(l=>l.id===id);if(!found)throw Error('label missing');found.name=name;writes.push(['labelRename',id]);fail('afterRenameLabel');return clone(found);},
    create(f){fail('create');const result={id:'new-'+(++serial),...clone(f)};data.filters.push(result);writes.push(['create',result.id]);fail('afterCreate');return clone(result);},
    delete(id){fail('delete');const i=data.filters.findIndex(f=>f.id===id);if(i<0)throw new Error('not found');data.filters.splice(i,1);writes.push(['delete',id]);fail('afterDelete');}
  };
  const state={get(k){return props[k]===undefined?null:clone(props[k]);},set(k,v){fail('state:'+k);props[k]=clone(v);},remove(k){delete props[k];}};
  const deps={store,gmail,state,hash,uuid:()=>crypto.randomUUID(),now:()=>time,actor:()=>'',notify:()=>{}};
  return {deps,data,rows,labelRows,props,backups,scopes,history,writes,diffs,faults,tick(ms){time+=ms;},key};
}
module.exports={harness,key,labels,base,hash};
