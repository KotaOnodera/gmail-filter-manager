'use strict';
function fakeSheets(){
  const sheets=new Map(),events=[];let nextMetadata=0;
  class Range{
    constructor(s,r,c,n=1,m=1,entireRow=false){Object.assign(this,{s,r,c,n,m,entireRow});}
    getValues(){return Array.from({length:this.n},(_,i)=>Array.from({length:this.m},(_,j)=>this.s.values[this.r+i-1]?.[this.c+j-1]??''));}
    getFormulas(){return Array.from({length:this.n},(_,i)=>Array.from({length:this.m},(_,j)=>this.s.formulas[this.r+i-1]?.[this.c+j-1]??''));}
    setRichTextValues(values){events.push('richText');values.forEach((row,i)=>row.forEach((v,j)=>{const y=this.r+i-1,x=this.c+j-1;this.s.values[y]??=[];this.s.formulas[y]??=[];this.s.values[y][x]=v.getText();this.s.formulas[y][x]='';}));return this;}
    clearContent(){for(let i=0;i<this.n;i++)for(let j=0;j<this.m;j++){if(this.s.values[this.r+i-1])this.s.values[this.r+i-1][this.c+j-1]='';}return this;}
    setNumberFormat(){return this;}setBackground(){return this;}setFontColor(){return this;}setFontWeight(){return this;}setWrapStrategy(){return this;}setDataValidation(){return this;}
    protect(){const p={description:'',setDescription(v){this.description=v;return this;},getDescription(){return this.description;},setWarningOnly(){return this;}};this.s.protections.push(p);return p;}
    createTextFinder(text){const range=this;let entire=false,caseSensitive=false;return {matchEntireCell(v){entire=v;return this;},matchCase(v){caseSensitive=v;return this;},useRegularExpression(v){if(v)throw Error('Regex finder not implemented');return this;},findAll(){const matches=[];for(let i=0;i<range.n;i++)for(let j=0;j<range.m;j++){let value=String(range.s.values[range.r+i-1]?.[range.c+j-1]??''),wanted=text;if(!caseSensitive){value=value.toLowerCase();wanted=wanted.toLowerCase();}if(entire?value===wanted:value.includes(wanted))matches.push(new Range(range.s,range.r+i,range.c+j));}return matches;}};}
    createFilter(){this.s.filter={};return this.s.filter;}
    getRow(){return this.r;}
    addDeveloperMetadata(key,value){if(!this.entireRow)throw new Error('Adding developer metadata to arbitrary ranges is not currently supported');const ref=this.s.values[this.r-1],s=this.s;const m={id:++nextMetadata,key,value,getId(){events.push('metadataGetId');return this.id;},getValue(){events.push('metadataGetValue');return this.value;},getLocation(){return {getRow:()=>new Range(s,s.values.indexOf(ref)+1,1,1,s.maxCols)};},ref};this.s.metadata.push(m);return this;}
  }
  class Sheet{
    constructor(name){this.name=name;this.values=[];this.formulas=[];this.protections=[];this.metadata=[];this.maxRows=1000;this.maxCols=26;}
    createDeveloperMetadataFinder(){const s=this;let key,value;return {withKey(k){key=k;return this;},withValue(v){value=v;return this;},find(){events.push('metadataFind');return s.metadata.filter(m=>m.key===key&&(value===undefined||m.value===value)&&s.values.includes(m.ref));}};}
    getRange(...args){if(typeof args[0]==='string'){const match=args[0].match(/^(\d+):(\d+)$/);if(!match)throw new Error('Unsupported fake range');return new Range(this,Number(match[1]),1,Number(match[2])-Number(match[1])+1,this.maxCols,true);}return new Range(this,...args);}getName(){return this.name;}getSheetId(){return [...sheets.values()].indexOf(this);}
    setName(name){sheets.delete(this.name);this.name=name;sheets.set(name,this);return this;}
    getLastRow(){let i=this.values.length;while(i&&!this.values[i-1].some(v=>v!==''))i--;return i;}
    getLastColumn(){return Math.max(0,...this.values.map(r=>r.length));}
    getMaxRows(){return this.maxRows;}getMaxColumns(){return this.maxCols;}
    insertRowsAfter(_,n){this.maxRows+=n;}insertColumnsAfter(_,n){this.maxCols+=n;}
    getProtections(){return this.protections;}getFilter(){return this.filter;}setFrozenRows(){}setColumnWidths(){}hideColumns(){}activate(){events.push('activate:'+this.name);}
  }
  const book={getId:()=>'book',getSheetByName:n=>sheets.get(n)||null,insertSheet(n){const s=new Sheet(n);sheets.set(n,s);return s;},getSheets:()=>[...sheets.values()],toast:m=>events.push(m)};
  const app={newRichTextValue(){let text;return {setText(t){text=t;return this;},build(){return {getText:()=>text};}};},newDataValidation(){return {requireValueInList(){return this;},requireValueInRange(){return this;},setAllowInvalid(){return this;},build(){return {};}};},flush(){events.push('flush');},ProtectionType:{RANGE:'RANGE'},WrapStrategy:{CLIP:'CLIP'}};
  app.DeveloperMetadataVisibility={DOCUMENT:'DOCUMENT'};
  const api={Spreadsheets:{Values:{batchUpdateByDataFilter(body){events.push('valuesBatchUpdate');if(api.beforeAtomicWrite)api.beforeAtomicWrite();let n=0,cells=0;for(const entry of body.data){const id=entry.dataFilter.developerMetadataLookup.metadataId;for(const s of sheets.values()){const m=s.metadata.find(m=>m.id===id&&s.values.includes(m.ref));if(m){entry.values[0].forEach((v,i)=>{if(v!==null){m.ref[i]=v;cells++;}});n++;}}}return {totalUpdatedRows:n,totalUpdatedCells:cells,totalUpdatedSheets:n?1:0};}}}};
  api.Spreadsheets.DeveloperMetadata={search(body){events.push('metadataSearch');const lookup=body.dataFilters[0].developerMetadataLookup,matches=[];for(const s of sheets.values())if(s.getSheetId()===lookup.metadataLocation.sheetId)for(const m of s.metadata)if(m.key===lookup.metadataKey&&s.values.includes(m.ref))matches.push({developerMetadata:{metadataKey:m.key,metadataValue:m.value,metadataId:m.id,location:{dimensionRange:{sheetId:s.getSheetId(),dimension:'ROWS',startIndex:s.values.indexOf(m.ref),endIndex:s.values.indexOf(m.ref)+1}}}});return {matchedDeveloperMetadata:matches};}};
  api.Spreadsheets.batchUpdate=body=>{events.push('metadataBatch:'+body.requests.length);const replies=[];for(const request of body.requests){const m=request.createDeveloperMetadata.developerMetadata,range=m.location.dimensionRange,s=[...sheets.values()].find(s=>s.getSheetId()===range.sheetId);if(!s||range.dimension!=='ROWS'||range.endIndex!==range.startIndex+1)throw Error('invalid row metadata');const ref=s.values[range.startIndex],metadata={id:++nextMetadata,key:m.metadataKey,value:m.metadataValue,ref,getId(){events.push('metadataGetId');return this.id;},getValue(){events.push('metadataGetValue');return this.value;},getLocation(){return {getRow:()=>new Range(s,s.values.indexOf(ref)+1,1,1,s.maxCols)};}};s.metadata.push(metadata);replies.push({createDeveloperMetadata:{developerMetadata:{...m,metadataId:metadata.id}}});}return {replies};};
  return {book,app,api,sheets,events};
}
module.exports={fakeSheets};
