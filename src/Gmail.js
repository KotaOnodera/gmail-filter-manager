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
    return {
      read,
      create:filter=>service.Users.Settings.Filters.create({criteria:filter.criteria,action:filter.action},'me'),
      delete:id=>service.Users.Settings.Filters.remove('me',id)
    };
  }
  return {create};
})();
if(typeof module!=='undefined')module.exports=GFMGmail;
