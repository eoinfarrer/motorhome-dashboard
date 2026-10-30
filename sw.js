self.addEventListener('install',function(){self.skipWaiting();});
self.addEventListener('activate',function(event){event.waitUntil(self.clients.claim());});

self.addEventListener('push',function(event){
  var data={};
  try{data=event.data?event.data.json():{};}catch(_error){data={body:event.data?event.data.text():'Open Audrey for details.'};}
  event.waitUntil(self.registration.showNotification(data.title||'Audrey Travel OS',{
    body:data.body||'Open Audrey for details.',
    tag:data.tag||'audrey-alert',
    icon:'/assets/audrey-icon.svg',
    data:{url:data.url||'/'},
    renotify:true
  }));
});

self.addEventListener('notificationclick',function(event){
  event.notification.close();
  var destination=new URL(event.notification.data&&event.notification.data.url||'/',self.location.origin).href;
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(windows){
    for(var i=0;i<windows.length;i++){
      if('focus' in windows[i]){windows[i].navigate(destination);return windows[i].focus();}
    }
    return self.clients.openWindow(destination);
  }));
});
