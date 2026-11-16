import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { tokenVault } from '../server/social-store.mjs';
import { registerSocialPublishing } from '../server/social-publishing.mjs';
import { createSocialProviders, publishingConfig, uploadChunks } from '../server/social-providers.mjs';

const secret = 'test-secret-never-used-in-production-123456';
const config = publishingConfig({ CLIP_MAKER_AUTH_SITE_URL:'https://clip-maker.test', YOUTUBE_CLIENT_ID:'yt-id', YOUTUBE_CLIENT_SECRET:'yt-secret', INSTAGRAM_CLIENT_ID:'ig-id', INSTAGRAM_CLIENT_SECRET:'ig-secret', TIKTOK_CLIENT_KEY:'tt-key', TIKTOK_CLIENT_SECRET:'tt-secret' });
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {status,headers});

test('tokens are encrypted and bound to their owner and platform', () => {
  const vault = tokenVault(secret);
  const encrypted = vault.seal({access_token:'private-token'}, '1:youtube');
  assert.ok(!encrypted.includes('private-token'));
  assert.deepEqual(vault.open(encrypted,'1:youtube'),{access_token:'private-token'});
  assert.throws(() => vault.open(encrypted,'2:youtube'));
  assert.throws(() => vault.open(encrypted,'1:tiktok'));
  assert.throws(() => tokenVault('short'));
});

test('TikTok chunk sizes include remainders and follow platform limits', () => {
  for (const size of [10, 5e6, 10e6, 15e6, 25e6, 64e6, 100e6, 500*1024*1024]) {
    const chunks = uploadChunks(size);
    assert.equal(chunks[0].start,0);
    assert.equal(chunks.at(-1).end,size-1);
    assert.equal(chunks.reduce((n,c)=>n+c.end-c.start+1,0),size);
    for(let i=1;i<chunks.length;i++) assert.equal(chunks[i].start,chunks[i-1].end+1);
    assert.ok(chunks.slice(0,-1).every(c=>c.end-c.start+1>=5e6 && c.end-c.start+1<=64e6));
  }
});

test('Instagram exchanges the documented nested token response', async () => {
  let calls = 0;
  const providers = createSocialProviders(config, async (url, options) => {
    calls++;
    if(calls===1) { assert.equal(url,'https://api.instagram.com/oauth/access_token'); assert.ok(options.body instanceof FormData); return response({data:[{access_token:'short'}]}); }
    assert.equal(new URL(url).searchParams.get('access_token'),'short');
    return response({access_token:'long',expires_in:5184000});
  });
  assert.equal((await providers.exchange('instagram','code','verifier')).access_token,'long');
  const auth = new URL(providers.authorization('instagram','state','challenge'));
  assert.match(auth.searchParams.get('scope'),/instagram_business_content_publish/);
  assert.equal(auth.searchParams.get('force_reauth'),'true');
});

test('TikTok rechecks privacy and creator limits before any upload', async () => {
  let init = 0;
  const providers = createSocialProviders(config, async (url) => {
    if (url.includes('creator_info')) return response({data:{privacy_level_options:['PUBLIC_TO_EVERYONE','SELF_ONLY'],max_video_post_duration_sec:60},error:{code:'ok'}});
    init++; throw Error('must not upload');
  });
  const creator = await providers.creator('tiktok','token');
  assert.deepEqual(creator.privacy,['SELF_ONLY']);
  await assert.rejects(providers.upload('tiktok','token',{}, {duration:30,size:100}, {privacy:'PUBLIC_TO_EVERYONE'}),/privacy options/);
  await assert.rejects(providers.upload('tiktok','token',{}, {duration:90,size:100}, {privacy:'SELF_ONLY'}),/maximum/);
  assert.equal(init,0);
});

function memoryStore() {
  const accounts = new Map(), states = new Map(), posts = new Map();
  return {
    accounts: async u => [...accounts.values()].filter(a=>a.user_id===u).map(({tokens,...a})=>a),
    account: async (u,p) => accounts.get(`${u}:${p}`),
    saveAccount: async (u,p,a) => accounts.set(`${u}:${p}`,{...a,user_id:u,platform:p}),
    disconnect: async (u,p) => accounts.delete(`${u}:${p}`),
    withAccountLock: async (u,p,fn) => fn(),
    saveState: async (id,u,p,verifier) => states.set(id,{user:u,platform:p,verifier}),
    consumeState: async (id,u,p) => { const s=states.get(id);if(s?.user!==u||s.platform!==p)return;states.delete(id);return s; },
    createPost: async p => { if(posts.has(p.id))return;const row={...p,status:'uploading'};posts.set(p.id,row);return {...row}; },
    post: async (id,u) => posts.get(id)?.user_id===u ? {...posts.get(id)} : undefined,
    posts: async u => [...posts.values()].filter(p=>p.user_id===u),
    updatePost: async(id,u,state) => { if(posts.get(id)?.user_id===u)Object.assign(posts.get(id),state); },
    claimPost: async(id,u) => { const p=posts.get(id);if(p?.user_id!==u||p.status!=='processing')return; p.status='checking';return {...p}; },
  };
}

test('authenticated publishing isolates users, rejects CSRF, and prevents duplicate uploads', async t => {
  const dir = await mkdtemp(join(tmpdir(),'social-publish-test-'));
  const path = join(dir,'clip.mp4');await writeFile(path,Buffer.alloc(100));
  const store = memoryStore();const vault = tokenVault(secret);
  await store.saveAccount(1,'youtube',{external_id:'channel-1',label:'Test channel',tokens:vault.seal({access_token:'private-token',expires_at:Date.now()+3600000},'1:youtube')});
  const app=express();let uploads=0,exchanges=0;
  const providers = {
    authorization:(p,state)=>`https://accounts.google.com/auth?state=${state}`,
    exchange:async()=>{exchanges++;return {access_token:'new-token',expires_at:Date.now()+3600000};},
    profile:async()=>({external_id:'channel-1',label:'Test channel'}),
    upload:async()=>{uploads++;await new Promise(r=>setTimeout(r,30));return {status:'processing',remote:{id:'yt-video'},url:'https://www.youtube.com/watch?v=yt-video'};},
    check:async()=>({status:'published'}),revoke:async()=>{},
  };
  const env={JWT_SECRET:secret,CLIP_MAKER_AUTH_SITE_URL:'http://localhost:9000',YOUTUBE_CLIENT_ID:'id',YOUTUBE_CLIENT_SECRET:'secret'};
  registerSocialPublishing(app,{store,providers,background:false,authenticate:async req=>req.get('x-user')?{id:Number(req.get('x-user'))}:null,
    getClip:async(id,user)=>id===5&&user===1?{id,status:'done',downloadUrl:'/api/media/clip/owned.mp4'}:null,
    getClipPath:async()=>path,probeMedia:async()=>({duration:30}),getPublicClipUrl:async()=>null},env);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const call=(route,{method='GET',body,user=1,csrf='http://localhost:9000',cookie}={})=>fetch(origin+'/api/social'+route,{method,redirect:'manual',headers:{'Content-Type':'application/json',...(user?{'x-user':String(user)}:{}),Origin:csrf,...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await call('/accounts',{user:0})).status,401);
  assert.equal((await call('/connect/youtube',{method:'POST',csrf:'https://evil.test'})).status,403);
  const publicAccounts=await(await call('/accounts')).text(); assert.ok(publicAccounts.includes('Test channel'));assert.ok(!publicAccounts.includes('private-token'));assert.ok(!publicAccounts.includes('tokens'));
  assert.ok(!(await(await call('/accounts',{user:2})).text()).includes('Test channel'));
  const auth=await call('/connect/youtube',{method:'POST'});const cookie=auth.headers.get('set-cookie').split(';')[0];const state=new URL((await auth.json()).url).searchParams.get('state');
  await call(`/callback/youtube?code=code&state=${state}`,{user:2,cookie});assert.equal(exchanges,0);
  assert.match((await call(`/callback/youtube?code=code&state=${state}`,{cookie})).headers.get('location'),/success/);
  await call(`/callback/youtube?code=code&state=${state}`,{cookie});assert.equal(exchanges,1);
  const body={id:randomUUID(),clipId:5,platform:'youtube',title:'My video',caption:'دارجة',privacy:'private',madeForKids:false,consent:true,ownsContent:true};
  assert.equal((await call('/posts',{method:'POST',body:{...body,consent:false}})).status,400);
  assert.equal((await call('/posts',{method:'POST',body:{...body,clipId:6}})).status,404);
  const [a,b]=await Promise.all([call('/posts',{method:'POST',body}),call('/posts',{method:'POST',body})]);
  assert.ok([200,202].includes(a.status));assert.ok([200,202].includes(b.status));assert.equal(uploads,1);
  assert.equal((await call('/posts',{method:'POST',body:{...body,title:'different'}})).status,409);
  assert.equal((await call(`/posts/${body.id}/refresh`,{method:'POST',user:2})).status,404);
  const finished=await(await call(`/posts/${body.id}/refresh`,{method:'POST'})).json();assert.equal(finished.post.status,'published');assert.ok(!JSON.stringify(finished).includes('remote'));
  await call('/posts',{method:'POST',body});assert.equal(uploads,1);
  providers.upload=async()=>{uploads++;throw Error('network failed token=SECRET');};
  const interrupted={...body,id:randomUUID()};const uncertain=await(await call('/posts',{method:'POST',body:interrupted})).json();
  assert.equal(uncertain.post.status,'unknown');assert.ok(!JSON.stringify(uncertain).includes('SECRET'));
  await call('/posts',{method:'POST',body:interrupted});assert.equal(uploads,2);
  assert.equal((await call('/accounts/youtube',{method:'DELETE'})).status,200);
});

test('YouTube streams the rendered MP4 and preserves explicit audience/privacy', async t => {
  const dir=await mkdtemp(join(tmpdir(),'youtube-upload-test-'));const path=join(dir,'clip.mp4');await writeFile(path,'video-bytes');t.after(()=>rm(dir,{recursive:true,force:true}));
  let calls=0;
  const providers=createSocialProviders(config,async(url,options)=>{
    calls++;
    if(calls===1){const payload=JSON.parse(options.body);assert.equal(payload.status.privacyStatus,'private');assert.equal(payload.status.selfDeclaredMadeForKids,false);assert.equal(payload.snippet.description,'دارجة مغربية');return response({},200,{location:'https://www.googleapis.com/upload/session/test'});}
    if(calls===2){assert.equal(options.method,'PUT');assert.equal(options.headers['Content-Length'],'11');let bytes='';for await(const part of options.body)bytes+=part;assert.equal(bytes,'video-bytes');return response({id:'video-1'});}
    return response({items:[{status:{uploadStatus:'processed'}}]});
  });
  const result=await providers.upload('youtube','token',{}, {path,size:11},{title:'Title',caption:'دارجة مغربية',privacy:'private',madeForKids:false,aiGenerated:false});
  assert.equal(result.status,'processing');assert.equal((await providers.check('youtube','token',{},result.remote)).status,'published');
});

test('Instagram waits for processing, then publishes the accepted container', async () => {
  let published=0,ready=false;
  const providers=createSocialProviders(config,async(url,options={})=>{
    if(url.endsWith('/account/media')){assert.equal(options.body.get('media_type'),'REELS');assert.equal(options.body.get('video_url'),'https://media.test/signed-video');return response({id:'container-1'});}
    if(url.includes('status_code'))return response({status_code:ready?'FINISHED':'IN_PROGRESS'});
    if(url.endsWith('/account/media_publish')){published++;assert.equal(options.body.get('creation_id'),'container-1');return response({id:'published-1'});}
    return response({permalink:'https://www.instagram.com/reel/test/'});
  });
  const account={external_id:'account'};
  const uploaded=await providers.upload('instagram','token',account,{publicUrl:'https://media.test/signed-video'},{caption:'دارجة'});
  assert.equal((await providers.check('instagram','token',account,uploaded.remote)).status,'processing');assert.equal(published,0);
  ready=true;const result=await providers.check('instagram','token',account,uploaded.remote);assert.equal(result.status,'published');assert.equal(published,1);assert.match(result.url,/instagram.com/);
});

test('TikTok uploads chunks, respects disabled interactions, and checks final status', async t => {
  const dir=await mkdtemp(join(tmpdir(),'tiktok-upload-test-'));const path=join(dir,'clip.mp4');await writeFile(path,'video-bytes');t.after(()=>rm(dir,{recursive:true,force:true}));
  let uploaded=0;
  const providers=createSocialProviders(config,async(url,options={})=>{
    if(url.includes('creator_info'))return response({data:{privacy_level_options:['SELF_ONLY'],max_video_post_duration_sec:60,comment_disabled:true,duet_disabled:true,stitch_disabled:false},error:{code:'ok'}});
    if(url.includes('/video/init')){const payload=JSON.parse(options.body);assert.equal(payload.post_info.privacy_level,'SELF_ONLY');assert.equal(payload.post_info.disable_comment,true);assert.equal(payload.post_info.disable_duet,true);assert.equal(payload.post_info.disable_stitch,false);assert.equal(payload.source_info.video_size,11);return response({data:{publish_id:'p1',upload_url:'https://upload.us.tiktokapis.com/video/test'},error:{code:'ok'}});}
    if(url.includes('/video/test')){assert.equal(options.headers['Content-Range'],'bytes 0-10/11');for await(const chunk of options.body)uploaded+=chunk.length;return new Response(null,{status:201});}
    return response({data:{status:'PUBLISH_COMPLETE'},error:{code:'ok'}});
  });
  const result=await providers.upload('tiktok','token',{}, {path,size:11,duration:20},{caption:'دارجة',privacy:'SELF_ONLY',allowComments:true,allowDuet:true,allowStitch:true,brandedContent:false,ownBrand:false,aiGenerated:false});
  assert.equal(uploaded,11);assert.equal(result.remote.id,'p1');assert.equal((await providers.check('tiktok','token',{},result.remote)).status,'published');
});
