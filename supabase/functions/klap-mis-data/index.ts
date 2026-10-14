import { createClient } from 'jsr:@supabase/supabase-js@2'
const supabase = createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
async function fetchAll(table:string,select:string,orderCol='id'){const PAGE=1000;let all:any[]=[],from=0;while(true){const{data,error}=await supabase.from(table).select(select).order(orderCol,{ascending:false}).range(from,from+PAGE-1);if(error)throw new Error(`${table}: ${error.message}`);if(!data||data.length===0)break;all=all.concat(data);if(data.length<PAGE)break;from+=PAGE;}return all;}

const DRIVE_FOLDER_ID='1_upxmdMWqknVRnrGKVzkUH4VBcEpyznr';
let _driveCache:Record<string,string>|null=null;
let _driveCacheTime=0;

async function getServiceAccountToken():Promise<string>{
  const sa=JSON.parse(Deno.env.get('GOOGLE_SERVICE_ACCOUNT')!)
  const now=Math.floor(Date.now()/1000)
  const header={alg:'RS256',typ:'JWT'}
  const payload={iss:sa.client_email,scope:'https://www.googleapis.com/auth/drive.readonly',aud:'https://oauth2.googleapis.com/token',exp:now+3600,iat:now}
  const enc=(obj:any)=>btoa(JSON.stringify(obj)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')
  const sigInput=enc(header)+'.'+enc(payload)
  const pemContents=sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----/g,'').replace(/\n/g,'').trim()
  const keyData=Uint8Array.from(atob(pemContents),c=>c.charCodeAt(0))
  const key=await crypto.subtle.importKey('pkcs8',keyData,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign'])
  const sig=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(sigInput))
  const sigB64=btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')
  const jwt=sigInput+'.'+sigB64
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`})
  const d=await r.json()
  if(!d.access_token)throw new Error('Failed to get token: '+JSON.stringify(d))
  return d.access_token
}

async function buildDriveCache(token:string):Promise<Record<string,string>>{
  const cache:Record<string,string>={}
  let pageToken:string|undefined=undefined
  do {
    const qs=new URLSearchParams({
      q:`'${DRIVE_FOLDER_ID}' in parents and trashed=false`,
      fields:'nextPageToken,files(id,name)',
      pageSize:'1000'
    })
    if(pageToken)qs.set('pageToken',pageToken)
    const r=await fetch(`https://www.googleapis.com/drive/v3/files?${qs}`,{headers:{Authorization:'Bearer '+token}})
    const data=await r.json()
    ;(data.files||[]).forEach((f:any)=>{
      const name=f.name.replace(/\.[^.]+$/,'')
      cache[name]=f.id
    })
    pageToken=data.nextPageToken
  } while(pageToken)
  return cache
}

async function getDriveFileId(productId:string,token:string):Promise<string|null>{
  const now=Date.now();
  if(!_driveCache||now-_driveCacheTime>1800000){
    _driveCache=await buildDriveCache(token)
    _driveCacheTime=now
  }
  return _driveCache[productId]||null
}

Deno.serve(async(req)=>{
  if(req.method==='OPTIONS')return new Response(null,{headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'}})
  const url=new URL(req.url)

  const imageMatch=url.pathname.match(/\/image\/([^/]+)$/)
  if(imageMatch){
    const productId=decodeURIComponent(imageMatch[1])
    try{
      const token=await getServiceAccountToken()
      const fileId=await getDriveFileId(productId,token)
      if(!fileId)return new Response('Not found',{status:404,headers:{'Access-Control-Allow-Origin':'*'}})
      const r=await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,{headers:{Authorization:'Bearer '+token}})
      if(!r.ok)return new Response('Not found',{status:404,headers:{'Access-Control-Allow-Origin':'*'}})
      const blob=await r.blob()
      return new Response(blob,{headers:{'Content-Type':r.headers.get('Content-Type')||'image/jpeg','Cache-Control':'public, max-age=86400','Access-Control-Allow-Origin':'*'}})
    }catch(e:any){
      return new Response(JSON.stringify({error:e.message}),{status:500,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}})
    }
  }

  if(url.pathname.endsWith('/auth')){
    const{email}=await req.json().catch(()=>({}))
    if(!email)return new Response(JSON.stringify({error:'No email'}),{status:400,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}})
    const{data:user,error}=await supabase.from('app_users').select('id,email,name,role_id,is_active').eq('email',email).single()
    if(error||!user)return new Response(JSON.stringify({error:'not_found'}),{status:403,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}})
    if(!user.is_active)return new Response(JSON.stringify({error:'inactive'}),{status:403,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}})
    const{data:perms}=await supabase.from('role_permissions').select('resource,can_read,can_write,can_delete,visible_fields,hidden_fields,row_filter').eq('role_id',user.role_id)
    await supabase.from('app_users').update({last_login:new Date().toISOString()}).eq('id',user.id)
    await supabase.from('audit_log').insert({user_email:email,user_name:user.name,role_id:user.role_id,action:'login',resource:'auth'})
    return new Response(JSON.stringify({user,permissions:perms||[]}),{headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}})
  }
  // ── WRITE: authenticated, permission-checked saves (production) ─────────────
  if(url.pathname.endsWith('/write')&&req.method==='POST'){
    const H={'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}
    const J=(o:any,s=200)=>new Response(JSON.stringify(o),{status:s,headers:H})
    try{
      const tok=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'').trim()
      if(!tok)return J({error:'Not signed in'},401)
      const{data:ud,error:ue}=await supabase.auth.getUser(tok)
      const email=ud?.user?.email
      if(ue||!email)return J({error:'Session expired — please sign in again'},401)
      const{data:au}=await supabase.from('app_users').select('id,name,role_id,is_active').eq('email',email).single()
      if(!au||!au.is_active)return J({error:'You are not authorised to make changes'},403)
      const body=await req.json().catch(()=>({}))
      const table=String(body.table||''),op=String(body.op||''),id=body.id!=null?String(body.id):'',data=body.data||{}
      const RULES:Record<string,{ops:string[],fields:string[]}>={
        pro_steps:{ops:['insert','update','delete'],fields:['process_name','prod_order_id','vendor_id','machine','die_id','plate_id','material_id','seq','step_status','qty_in','qty_out','wastage','done_by','date','varnish','foil']},
        jobs:{ops:['update'],fields:['job_name','job_type','status']}
      }
      const rule=RULES[table]
      if(!rule||!rule.ops.includes(op))return J({error:`Not allowed: ${op} on ${table}`},400)
      if(au.role_id!=='owner'){
        const{data:perm}=await supabase.from('role_permissions').select('can_write,can_delete').eq('role_id',au.role_id).eq('resource',table).single()
        const ok=op==='delete'?perm?.can_delete:perm?.can_write
        if(!ok)return J({error:`Your role (${au.role_id}) cannot ${op==='delete'?'delete':'change'} ${table}`},403)
      }
      const clean:Record<string,any>={}
      for(const k of rule.fields)if(k in data)clean[k]=data[k]===''?null:data[k]
      const STEP_ST=['pending','in_progress','done','skipped','cancelled']
      const LEGACY:Record<string,string>={pending:'To Send',in_progress:'Part Processed',done:'Moved',skipped:'Skipped',cancelled:'Cancelled'}
      if(table==='pro_steps'){
        if('step_status' in clean){
          if(!STEP_ST.includes(clean.step_status))return J({error:'Invalid step status'},400)
          clean.process_status=LEGACY[clean.step_status]
        }
        for(const k of ['seq','qty_in','qty_out','wastage'])if(k in clean&&clean[k]!=null){const n=Number(clean[k]);if(!Number.isFinite(n)||n<0)return J({error:`Invalid ${k}`},400);clean[k]=Math.round(n)}
        if(clean.vendor_id&&clean.machine)return J({error:'A step is either in-house (machine) or outsourced (vendor), not both'},400)
      }
      if(table==='jobs'&&'job_type' in clean&&clean.job_type!=null&&!['Machine','Sheet','Tupax','Direct'].includes(clean.job_type))return J({error:'Invalid job type'},400)
      if(table==='jobs'&&'status' in clean&&clean.status!=null&&!['planned','in_progress','done'].includes(clean.status))return J({error:'Invalid job status'},400)
      let row:any=null,old:any=null
      if(op!=='insert'){
        if(!id)return J({error:'Missing id'},400)
        const{data:o}=await supabase.from(table).select('*').eq('id',id).single()
        if(!o)return J({error:'Record not found'},404)
        old=o
      }
      if(op==='insert'){
        if(!clean.prod_order_id||!clean.process_name)return J({error:'PRO and process are required'},400)
        const{data:pro}=await supabase.from('production_orders').select('id').eq('id',clean.prod_order_id).single()
        if(!pro)return J({error:'PRO not found'},404)
        if(!clean.step_status){clean.step_status='pending';clean.process_status=LEGACY.pending}
        if(!clean.date)clean.date=new Date(Date.now()+19800000).toISOString().slice(0,10)
        for(let i=0;i<3&&!row;i++){
          const{data:nid,error:ie}=await supabase.rpc('next_pro_step_id',{p_proc:clean.process_name})
          if(ie)return J({error:ie.message},500)
          const r=await supabase.from(table).insert({...clean,id:nid}).select().single()
          if(!r.error)row=r.data
          else if(!String(r.error.message).includes('duplicate'))return J({error:r.error.message},400)
        }
        if(!row)return J({error:'Could not create step id'},500)
      }else if(op==='update'){
        if(!Object.keys(clean).length)return J({error:'Nothing to update'},400)
        if(table==='pro_steps'){
          const v=('vendor_id' in clean)?clean.vendor_id:old.vendor_id, m=('machine' in clean)?clean.machine:old.machine
          if(v&&m){ if('vendor_id' in clean&&clean.vendor_id)clean.machine=null; else if('machine' in clean&&clean.machine)clean.vendor_id=null }
        }
        const r=await supabase.from(table).update(clean).eq('id',id).select().single()
        if(r.error)return J({error:r.error.message},400)
        row=r.data
      }else if(op==='delete'){
        if(table==='pro_steps'){
          if((old.qty_out||0)>0||!['pending',null,''].includes(old.step_status))return J({error:'Only an unstarted step can be deleted — mark it Skipped instead'},400)
          const{count}=await supabase.from('rm_out').select('id',{count:'exact',head:true}).eq('prod_proc_id',id)
          if(count&&count>0)return J({error:'Material has been issued against this step — mark it Skipped instead'},400)
        }
        const r=await supabase.from(table).delete().eq('id',id)
        if(r.error)return J({error:r.error.message},400)
      }
      await supabase.from('audit_log').insert({user_email:email,user_name:au.name,role_id:au.role_id,action:'app_'+op,resource:table,record_id:row?.id||id,old_data:old,new_data:row})
      return J({ok:true,row})
    }catch(e:any){return J({error:e.message||String(e)},500)}
  }

  if(url.pathname.endsWith('/admin')&&req.method==='GET'){
    const type=url.searchParams.get('type')
    if(type==='users'){const{data}=await supabase.from('app_users').select('id,email,name,role_id,is_active,last_login,created_at').order('created_at');return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}})}
    if(type==='roles'){const{data}=await supabase.from('roles').select('*').order('name');return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}})}
    if(type==='permissions'){const roleId=url.searchParams.get('role');let q=supabase.from('role_permissions').select('*');if(roleId)q=q.eq('role_id',roleId);const{data}=await q;return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}})}
    if(type==='audit'){const{data}=await supabase.from('audit_log').select('*').order('created_at',{ascending:false}).limit(500);return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}})}
  }
  if(url.pathname.endsWith('/admin')&&req.method==='POST'){
    const body=await req.json().catch(()=>({}))
    const{op,data,id}=body
    if(op==='upsert_user'){const{error}=await supabase.from('app_users').upsert(data,{onConflict:'email'});if(error)return new Response(JSON.stringify({error:error.message}),{status:400,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}})}
    else if(op==='upsert_role'){const{error}=await supabase.from('roles').upsert(data);if(error)return new Response(JSON.stringify({error:error.message}),{status:400,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}})}
    else if(op==='upsert_permission'){const{error}=await supabase.from('role_permissions').upsert(data,{onConflict:'role_id,resource'});if(error)return new Response(JSON.stringify({error:error.message}),{status:400,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}})}
    else if(op==='delete_user'){await supabase.from('app_users').delete().eq('id',id)}
    else if(op==='delete_role'){await supabase.from('roles').delete().eq('id',id).eq('is_system',false)}
    else if(op==='delete_permission'){const{role_id,resource}=data||{};if(role_id&&resource){await supabase.from('role_permissions').delete().eq('role_id',role_id).eq('resource',resource)}}
    return new Response(JSON.stringify({ok:true}),{headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}})
  }
  try{
    const orders=await fetchAll('orders','id,date,order_status,qty,is_repeat,has_changes,pplan_group,customer_id,product_id')
    const pros=await fetchAll('production_orders','id,date,qty,is_cancelled,is_on_hold,product_id,order_id,job_id,job_name,job_type,imposition_type,sheet_portion_l,sheet_portion_b,sheet_portion_units,sheet_qty,ups,blocks,pro_status')
    const products=await fetchAll('products','id,product_name,customer_name,design_status,material,size_l,size_b,size_units,category,product_class')
    const accounts=await fetchAll('accounts','id,name,brand,alias,account_type')
    const jobs=await fetchAll('jobs','id,date,job_name,job_type,status')
    const dies=await fetchAll('dies','id,die_name,total_ups,status,die_type')
    const plates=await fetchAll('plates','id,plate_name,status')
    const procs=await fetchAll('pro_steps','id,date,process_name,prod_order_id,material_id,qty_in,qty_out,step_status,process_status,vendor_id,machine,die_id,plate_id,wastage,seq,done_by')
    const rm_cats=await fetchAll('rm_categories','id,name','id')
    const rm_subcats=await fetchAll('rm_subcategories','id,name,category_id','id')
    const rm_list=await fetchAll('rm_list','id,alias,brand,category_id,subcategory_id,vendor_id','id')
    const rm_in=await fetchAll('rm_in','rm_in_id,date,rm_item_id,vendor_id,qty,qty_units,vendor_ref,status,category_id,subcategory_id,purchase_id,recd_date,freight_amt,carton_no','rm_in_id')
    const rm_out=await fetchAll('rm_out','id,date,rm_in_id,prod_proc_id,out_for,qty','id')
    const fg_inv=await fetchAll('fg_inventory','id,date,prod_order_id,inv_batch_id,d_no,ups,sheets,packets,qty,qty_units,qty_wastage,last_entry,fg_status','id')
    const dos=await fetchAll('delivery_orders','id,date,order_id,price,taxation')
    const do_items=await fetchAll('delivery_order_items','id,delivery_order_id,ds_item_pl_id,inv_batch_id,packet_qty','id')
    const pos=await fetchAll('purchase_orders','id,date,rm_id,vendor_id,pur_qty,rate,pur_unit,rate_units,status,bill_ref,comments')
    return new Response(JSON.stringify({orders,pros,products,accounts,jobs,dies,plates,procs,rm_cats,rm_subcats,rm_list,rm_in,rm_out,fg_inv,dos,do_items,pos,_counts:{orders:orders.length,pros:pros.length,products:products.length,accounts:accounts.length,jobs:jobs.length,procs:procs.length,rm_in:rm_in.length,fg_inv:fg_inv.length,dos:dos.length}}),{headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}})
  }catch(err:any){
    return new Response(JSON.stringify({error:err.message}),{status:500,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}})
  }
})
