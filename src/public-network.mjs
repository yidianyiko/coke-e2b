import http from 'node:http';
import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

const blocked = new net.BlockList();
for (const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]]) blocked.addSubnet(address,prefix,'ipv4');
const global6 = new net.BlockList(); global6.addSubnet('2000::',3,'ipv6');
const special6 = new net.BlockList();
for(const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) special6.addSubnet(address,prefix,'ipv6');
export function isPublicAddress(address) {
 const family=net.isIP(address);
 if(family===4)return !blocked.check(address,'ipv4');
 if(family===6)return global6.check(address,'ipv6')&&!special6.check(address,'ipv6');
 return false;
}
export function publicHttpUrl(value) {
 const url=new URL(value);
 const host=url.hostname.replace(/^\[|\]$/g,'');
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!host||net.isIP(host)&&!isPublicAddress(host))throw new Error('PUBLIC_NETWORK_REQUIRED');
 return url;
}

// The browser never resolves upstream names: each proxy connection is made to the
// exact validated numeric address. Every redirect and subresource reconnect is checked.
export async function createPublicNetworkProxy({lookup=host=>dnsLookup(host,{all:true,verbatim:true}),connect=options=>net.connect(options)}={}) {
 const sockets=new Set();
 function track(socket){
  sockets.add(socket);
  // Install before asynchronous DNS work: clients may reset while CONNECT is
  // awaiting lookup, before its tunnel-specific listeners have been installed.
  socket.on('error',()=>socket.destroy());
  socket.once('close',()=>sockets.delete(socket));
  return socket;
 }
 async function destination(url){
  const host=url.hostname.replace(/^\[|\]$/g,'');
  const records=net.isIP(host)?[{address:host,family:net.isIP(host)}]:await lookup(host);
  if(!records.length||records.some(r=>!isPublicAddress(r.address)))throw new Error('PUBLIC_NETWORK_REQUIRED');
  return {host:records[0].address,family:records[0].family,port:Number(url.port)||(url.protocol==='https:'?443:80)};
 }
 const server=http.createServer(async(req,res)=>{
  req.on('error',()=>req.destroy());
  res.on('error',()=>res.destroy());
  try {
   const url=publicHttpUrl(req.url);
   if(url.protocol!=='http:'||req.headers.upgrade)throw new Error('PUBLIC_NETWORK_REQUIRED');
   const options=await destination(url);
   const headers={...req.headers,host:url.host};
   delete headers['proxy-authorization'];delete headers['proxy-connection'];
   const agent=new http.Agent({keepAlive:false});
   agent.createConnection=()=>track(connect(options));
   const upstream=http.request({method:req.method,path:url.pathname+url.search,headers,host:options.host,port:options.port,agent},incoming=>{incoming.on('error',()=>res.destroy());res.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(res);});
   upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
   upstream.setTimeout(15000,()=>upstream.destroy());
   req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
  }catch{res.writeHead(403);res.end('PUBLIC_NETWORK_REQUIRED');}
 });
 server.on('connection',track);
 server.on('upgrade',(_req,socket)=>socket.destroy());
 server.on('connect',async(req,client,head)=>{
  try{
   if(!/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+):[0-9]+$/i.test(req.url))throw new Error('PUBLIC_NETWORK_REQUIRED');
   const url=publicHttpUrl('https://'+req.url);
   const options=await destination(url);
   if(client.destroyed)return;
   const upstream=track(connect(options));
   upstream.setTimeout(120000,()=>upstream.destroy());
   upstream.once('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
   upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());client.on('close',()=>upstream.destroy());
  }catch{client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {url:`http://127.0.0.1:${server.address().port}`,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
