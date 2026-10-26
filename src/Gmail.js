var GFMGmail = (function () {
  'use strict';
  function create(service) {
    function list(response,key) {
      if(!response||response.nextPageToken)throw new Error('Gmail一覧が不完全です/予期しないページがあります');
      const items=response[key]===undefined?[]:response[key];
      if(!Array.isArray(items))throw new Error('Gmail一覧が不正です');return items;
    }
    function read() {
      const filters=list(service.Users.Settings.Filters.list('me'),'filter');
      if(filters.length>1000||filters.some(f=>!f.id||!f.criteria||!f.action)||new Set(filters.map(f=>f.id)).size!==filters.length)throw new Error('Gmailフィルター全件取得が不完全です');
      const labels=list(service.Users.Labels.list('me'),'labels');
      const forwarding=list(service.Users.Settings.ForwardingAddresses.list('me'),'forwardingAddresses');
      return {filters,labels,forwarding};
    }
    function listMessages(query,pageToken) {
      const options={q:query,maxResults:500,includeSpamTrash:false};if(pageToken)options.pageToken=pageToken;
      const response=service.Users.Messages.list('me',options);
      if(!response||response.messages!==undefined&&!Array.isArray(response.messages)||response.nextPageToken!==undefined&&typeof response.nextPageToken!=='string')throw new Error('メール検索の一覧が不正です');
      const messages=response.messages||[];
      if(messages.some(m=>!m||typeof m.id!=='string'||!m.id))throw new Error('メール検索のIDが不正です');
      return {ids:messages.map(m=>m.id),nextPageToken:response.nextPageToken||''};
    }
    function modifyMessages(ids,action) {
      if(!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)throw new Error('更新するメールIDが不正です');
      if(!action||Object.keys(action).some(k=>!['addLabelIds','removeLabelIds'].includes(k))||!Array.isArray(action.addLabelIds)||!Array.isArray(action.removeLabelIds)||!action.addLabelIds.length&&!action.removeLabelIds.length||action.removeLabelIds.some(id=>!['INBOX','UNREAD'].includes(id)))throw new Error('既存メールに許可されていない処理です');
      const labels=list(service.Users.Labels.list('me'),'labels');
      if(action.addLabelIds.some(id=>!labels.some(l=>l.id===id&&l.type==='user')))throw new Error('追加できるのは存在するユーザーラベルだけです');
      return service.Users.Messages.batchModify({ids,addLabelIds:action.addLabelIds,removeLabelIds:action.removeLabelIds},'me');
    }
    return {
      read,listMessages,modifyMessages,
      create:filter=>service.Users.Settings.Filters.create({criteria:filter.criteria,action:filter.action},'me'),
      delete:id=>service.Users.Settings.Filters.remove('me',id)
    };
  }
  return {create};
})();
if(typeof module!=='undefined')module.exports=GFMGmail;
