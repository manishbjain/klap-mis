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

// Job images: Drive folder "Jobs - Final" (shared with the service account as Viewer).
// File names start with the job ID, then " - V<n> - ...". Latest version wins.
const JOB_IMG_FOLDER_ID='1vnKyWlz60YW2f_UqHyDK3oCyzEA6_P5d'
async function findJobImage(jobId:string,token:string):Promise<any|null>{
  const qs=new URLSearchParams({
    q:`'${JOB_IMG_FOLDER_ID}' in parents and trashed=false and name contains '${jobId.replace(/'/g,'')}'`,
    fields:'files(id,name,thumbnailLink,modifiedTime,mimeType)',pageSize:'50'
  })
  const r=await fetch(`https://www.googleapis.com/drive/v3/files?${qs}`,{headers:{Authorization:'Bearer '+token}})
  const d=await r.json()
  const esc=jobId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
  const re=new RegExp('^'+esc+'(?![0-9A-Za-z])','i')
  const files=(d.files||[]).filter((x:any)=>re.test(x.name)&&String(x.mimeType||'').startsWith('image/'))
  if(!files.length)return null
  const ver=(n:string)=>{const m=n.match(/\bV\s*(\d+)\b/i);return m?parseInt(m[1]):0}
  files.sort((a:any,b:any)=>(ver(b.name)-ver(a.name))||String(b.modifiedTime).localeCompare(String(a.modifiedTime)))
  return {...files[0],version:ver(files[0].name),count:files.length}
}

// ── JOB DRAFTS (AI reads a job image → draft in job_drafts; never touches live tables) ──
const AI_KEY=Deno.env.get('ANTHROPIC_API_KEY')??''
const AI_MODEL_DEFAULT=Deno.env.get('JOB_AI_MODEL')??'claude-sonnet-5-5'
const PROC_CODES=['PRT','COAT','LMN','EMB','FOIL','DVD','STRG','PUN','CUT','RW','SEAL','OTHER']
const JOB_DRAFT_TOOL={
  name:'record_job_draft',
  description:'Record the production plan read from the job image.',
  input_schema:{type:'object',properties:{
    job_type:{type:'string',enum:['Machine','Sheet','Tupax','Direct','Direct5','unknown']},
    job_type_conf:{type:'string',enum:['high','medium','low']},
    sheets:{type:'integer',description:'Sheets to print for the job (0 if not shown)'},
    sheets_conf:{type:'string',enum:['high','medium','low']},
    pros:{type:'array',items:{type:'object',properties:{
      ref:{type:'string',description:'Short ref A, B, C… used in processes'},
      pro_id:{type:'string',description:'Production order number written on the image, e.g. PROD10862 (empty if none)'},
      die_text:{type:'string',description:'Die code written for this PRO, e.g. D438 (empty if none)'},
      steps_text:{type:'string',description:'The process list written for this PRO exactly as on the image, e.g. "PRINTING - COATING - PUNCHING"'},
      product_text:{type:'string',description:'Product name exactly as it appears (artwork/label text or file name part)'},
      product_conf:{type:'string',enum:['high','medium','low']},
      ups:{type:'integer'},ups_conf:{type:'string',enum:['high','medium','low']},
      blocks:{type:'integer'},blocks_conf:{type:'string',enum:['high','medium','low']},
      sheets:{type:'integer',description:'Sheets for this product if different from the job total, else same as job'},
      evidence:{type:'string'}
    },required:['ref','product_text','product_conf','ups','ups_conf','blocks','blocks_conf']}},
    processes:{type:'array',description:'In order. Each process lists the PRO refs that go through it.',items:{type:'object',properties:{
      seq:{type:'integer'},
      process:{type:'string',enum:PROC_CODES},
      process_other:{type:'string'},
      pros:{type:'array',items:{type:'string'}},
      conf:{type:'string',enum:['high','medium','low']},
      evidence:{type:'string'}
    },required:['seq','process','pros','conf']}},
    visible_text:{type:'string',description:'Production-relevant text you can read on the image (job notes, marks, sizes, ups counts), max 1500 characters'},
    notes:{type:'string'}
  },required:['job_type','job_type_conf','pros','processes']}
}
const JOB_DRAFT_SYSTEM=`You read JOB IMAGES of Krishiv Labels & Packaging (Ahmedabad), a label and packaging printer.
A job image is the print-sheet layout exported from CorelDRAW for one print run (a "job"). Several products (labels/wrappers/cartons) can be printed together on the same sheet; each product printed in a job is one production order (PRO).
The file name follows: "<JobID> - V<version> - <date> - <product names...> - <material> - <sheet size> - <sheets> (<GSM>)". Use it as strong evidence for products, material, sheet size and sheet count.

Most job images carry a text note for every production order, like "PROD10862 - PRINTING - COATING - PUNCHING - D939": the PRO number, its processes in order, and the die code. These notes are the most reliable source: copy the PRO number into pro_id, the process words into steps_text and the die into die_text, and build the processes from them (PRINTING=PRT, COATING/UV/VARNISH=COAT, LAMINATION=LMN, EMBOSS=EMB, FOIL=FOIL, DIVIDE/DIVIDING=DVD, STRIP GUM=STRG, PUNCHING=PUN, CUTTING=CUT, REWINDING=RW). Make one PRO per PRO number.

Read the image carefully (artwork, text, marks, notes) and fill:
1. job_type (PPC type): Machine = roll-fed flexo label press (PPC1); Sheet = sheet-fed / hybrid sheet job (PPC2); Tupax = PPC3; Direct / Direct5 = bought-in, no in-house printing. Sheet sizes like "20 x 28" inches and GSM papers (Art Paper, Chromo, Duplex, Maplitho) mean Sheet.
2. PROs: one per distinct product on the sheet. ups = how many copies of that product are on one sheet. blocks = how many finished pieces each up gives (usually 1; e.g. a wrapper up that is later divided into 2 pieces → 2). pieces per sheet = ups × blocks. Count copies on the layout; do not guess.
3. processes in order, each with the PROs (refs) that go through it. All PROs start together at PRT. After that they may split (different PROs take different steps) and never rejoin. Codes:
 PRT print · COAT UV/varnish coating · LMN film lamination · EMB emboss · FOIL foil stamping · DVD divide (cut the big sheet into smaller portions, usually before punching/cutting) · STRG strip gumming (gum strips, for wrappers / non-adhesive labels) · PUN die punching (die-cut shapes) · CUT straight cutting/trimming to size (rectangles, no die) · RW rewinding rolls · SEAL sealing · OTHER (describe).
 Clues: shaped outlines/die lines → PUN; plain rectangles → CUT; "Strip Gum" / gum marks → STRG; lamination text (PVC/BOPP/Lamination) → LMN; UV/varnish → COAT. Packing is NOT a process.
Give a confidence for every field: high = clearly visible, medium = inferred from strong clues, low = guess. Never invent products that are not on the image or file name.`

async function bytesToB64(buf:ArrayBuffer):Promise<string>{
  const b=new Uint8Array(buf);let s='';const C=0x8000
  for(let i=0;i<b.length;i+=C)s+=String.fromCharCode(...b.subarray(i,i+C))
  return btoa(s)
}

async function runJobDraft(draftId:string){
  const upd=(o:any)=>supabase.from('job_drafts').update({...o,updated_at:new Date().toISOString()}).eq('id',draftId)
  try{
    const{data:d}=await supabase.from('job_drafts').select('*').eq('id',draftId).single()
    if(!d)return
    const token=await getServiceAccountToken()
    const f=await findJobImage(d.job_id,token)
    if(!f||!f.thumbnailLink){await upd({status:'error',error:'Job image not found in Drive'});return}
    const tl=f.thumbnailLink.replace(/=s\d+(-[a-z0-9-]+)?$/i,'')+'=s2000'
    const ir=await fetch(tl,{headers:{Authorization:'Bearer '+token}})
    if(!ir.ok){await upd({status:'error',error:'Could not load image preview'});return}
    const mt=(ir.headers.get('Content-Type')||'image/jpeg').split(';')[0]
    const b64=await bytesToB64(await ir.arrayBuffer())
    // PROs already linked to this job (if any) help the AI name products the same way
    const{data:known}=await supabase.from('production_orders').select('id,product_id,ups,blocks,sheet_qty').eq('job_id',d.job_id)
    const model=d.model||AI_MODEL_DEFAULT
    const content:any[]=[
      {type:'image',source:{type:'base64',media_type:mt,data:b64}},
      {type:'text',text:`File name: ${f.name}\nJob ID: ${d.job_id}\nRead this job image and call record_job_draft.`}
    ]
    const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',
      headers:{'x-api-key':AI_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},
      body:JSON.stringify({model,max_tokens:6000,system:JOB_DRAFT_SYSTEM+'\n\nAlways respond by calling the record_job_draft tool exactly once.',tools:[JOB_DRAFT_TOOL],tool_choice:{type:'auto'},messages:[{role:'user',content}]})})
    const j=await r.json()
    if(!r.ok){await upd({status:'error',error:'AI error: '+JSON.stringify(j).slice(0,400),file_id:f.id,file_name:f.name,model});return}
    let out:any=(j.content||[]).find((b:any)=>b.type==='tool_use')?.input
    const text=(j.content||[]).filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n')
    if(!out){const s=text.indexOf('{'),e=text.lastIndexOf('}');if(s>=0&&e>s){try{out=JSON.parse(text.slice(s,e+1))}catch{}}}
    if(!out){await upd({status:'error',error:'AI gave no draft',raw_output:text.slice(0,4000),file_id:f.id,file_name:f.name,model});return}
    // Some models return arrays as JSON strings — normalise
    for(const k of ['pros','processes'])if(typeof out[k]==='string'){try{out[k]=JSON.parse(out[k])}catch{out[k]=[]}}
    if(!Array.isArray(out.pros))out.pros=[]
    if(!Array.isArray(out.processes))out.processes=[]
    for(const x of out.processes)if(typeof x.pros==='string'){try{x.pros=JSON.parse(x.pros)}catch{x.pros=String(x.pros).split(/[ ,]+/).filter(Boolean)}}
    // Link to existing production orders (by PRO number) or suggest products from the master
    for(const p of out.pros){
      const pid=String(p.pro_id||'').toUpperCase().replace(/\s+/g,'').match(/PROD\d{4,6}/)?.[0]||''
      p.pro_id=pid||null
      p.pro_found=false
      if(pid){
        const{data:po}=await supabase.from('production_orders').select('id,product_id,ups,blocks,sheet_qty,job_id,products(product_name,customer_name)').eq('id',pid).maybeSingle()
        if(po){p.pro_found=true;p.pro={id:po.id,product_id:po.product_id,product_name:(po as any).products?.product_name,customer:(po as any).products?.customer_name,ups:po.ups,blocks:po.blocks,sheets:po.sheet_qty,job_id:po.job_id};p.product_id=po.product_id}
      }
      if(!p.product_id){
        const{data:m}=await supabase.rpc('tg_search_products',{p_customer:null,q:p.product_text||'',n:3})
        p.matches=(m||[]).map((x:any)=>({id:x.id,name:x.product_name,customer:x.customer_name,score:x.score}))
        p.product_id=p.matches[0]?.id||null
      }
      const s=Number(p.sheets||out.sheets||0)
      p.qty=s&&p.ups?s*p.ups*(p.blocks||1):null
    }
    out.known_pros=known||[]
    out.usage=j.usage
    await upd({status:'ready',draft:out,file_id:f.id,file_name:f.name,model,error:null})
  }catch(e:any){await upd({status:'error',error:String(e?.message||e)})}
}

Deno.serve(async(req)=>{
  if(req.method==='OPTIONS')return new Response(null,{headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'}})
  const url=new URL(req.url)

  // ── JOB IMAGES: /job-image/{jobId}?sz=1600  (shrunken copy only — never the full-size file)
  //    /job-image/{jobId}?info=1 → JSON with the latest version's file name
  const jobImgMatch=url.pathname.match(/\/job-image\/([^/]+)$/)
  if(jobImgMatch){
    const CH={'Access-Control-Allow-Origin':'*'}
    try{
      const jobId=decodeURIComponent(jobImgMatch[1]).trim()
      if(!/^[A-Za-z0-9_-]{2,20}$/.test(jobId))return new Response('Bad job id',{status:400,headers:CH})
      const token=await getServiceAccountToken()
      const f=await findJobImage(jobId,token)
      if(!f)return new Response('Not found',{status:404,headers:CH})
      if(url.searchParams.get('info')){
        return new Response(JSON.stringify({job_id:jobId,file_id:f.id,name:f.name,version:f.version,modified:f.modifiedTime,versions:f.count}),{headers:{...CH,'Content-Type':'application/json','Cache-Control':'private, max-age=300'}})
      }
      const sz=Math.max(200,Math.min(2400,parseInt(url.searchParams.get('sz')||'1600')||1600))
      if(!f.thumbnailLink)return new Response('Preview not ready yet',{status:404,headers:CH})
      const tl=f.thumbnailLink.replace(/=s\d+(-[a-z0-9-]+)?$/i,'')+`=s${sz}`
      const r=await fetch(tl,{headers:{Authorization:'Bearer '+token}})
      if(!r.ok)return new Response('Preview not available',{status:502,headers:CH})
      return new Response(await r.blob(),{headers:{...CH,'Content-Type':r.headers.get('Content-Type')||'image/jpeg','Cache-Control':'private, max-age=3600'}})
    }catch(e:any){
      return new Response(JSON.stringify({error:e.message}),{status:500,headers:{...CH,'Content-Type':'application/json'}})
    }
  }

  // ── Run a requested job draft. Needs the one-time run_token stored on the draft row.
  if(url.pathname.endsWith('/job-draft/run')){
    const CH={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'}
    const id=url.searchParams.get('id')||'',tk=url.searchParams.get('token')||''
    if(!id||!tk)return new Response(JSON.stringify({error:'id and token required'}),{status:400,headers:CH})
    const{data:d}=await supabase.from('job_drafts').select('id,status,run_token').eq('id',id).single()
    if(!d||d.run_token!==tk||d.status!=='requested')return new Response(JSON.stringify({error:'Not allowed'}),{status:403,headers:CH})
    await supabase.from('job_drafts').update({status:'running',run_token:null,updated_at:new Date().toISOString()}).eq('id',id)
    // @ts-ignore EdgeRuntime is provided by Supabase
    EdgeRuntime.waitUntil(runJobDraft(id))
    return new Response(JSON.stringify({ok:true,id,status:'running'}),{headers:CH})
  }

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
      // Every table the app can change, with the columns it may write (id/created_at are never written by hand)
      const COLS:Record<string,string[]>={
        orders:['date','customer_id','is_repeat','has_changes','product_id','party_reference','order_type','order_status','pplan_group','qty','units','bt','price','ledger_id','freight','transport_id','due_ds','billing_detail','billing_approved','despatch_location_1','despatch_location_2','despatch_detail','despatch_approved'],
        production_orders:['date','product_id','order_id','job_id','job_id_temp','job_name','imposition_type','job_type','imp_group','sheet_portion_l','sheet_portion_b','sheet_portion_units','sheet_qty','ups','blocks','qty','qty_units','is_cancelled','is_on_hold','packing_status','sent_for_packing','pro_status','completed_on','wastage_qty','wastage_reason'],
        products:['date','product_code','first_oid','product_class','customer_id','customer_name','category','version_type','old_reference','product_name','base_product','version_no','design_status','design_assigned','has_changes','change_desc','size_l','size_b','size_h','size_units','material','gsm','lamination','coating','foil','foil_color','emboss','gumming','gumming_type','border','data_clear','specs_final','thread_link','approval_proof'],
        accounts:['account_type','name','brand','alias','city','state','country','out_id'],
        jobs:['date','job_name','job_type','status'],
        dies:['date','die_type','die_name','up_size_l','up_size_b','total_ups','sheet_size','blocks','image_url','punch_type','status','vendor_id','face_stock','release','rule_ht','comments'],
        plates:['date','plate_name','job_size_b','cylinder','status'],
        rm_categories:['name'],
        rm_subcategories:['name','category_id','description'],
        rm_list:['date','category_id','subcategory_id','alias','brand','vendor_id','vendor_ref','color','top_or_base','top_coating','base_coating','inner_dia','outer_dia','height_mm','inner_circum','outer_circum','inner_liner'],
        rm_in:['date','entry_type','purchase_id','base_rm_in_id','category_id','subcategory_id','rm_item_id','despatch_date','recd_date','vendor_id','vendor_ref','current_inv_loc','carton_no','transfer_date','qty','qty_units','wt_per_pc','transport','total_pkgs','total_wt','freight_amt','status','comments','convert_kg_mtr','roll_width','roll_gross_wt','core_length','core_thickness','roll_sample_wt'],
        rm_out:['date','rm_in_id','out_for','prod_proc_id','conversion_vendor','temp_prod_proc_id','qty','comments'],
        purchase_orders:['date','rm_id','vendor_id','pur_unit','pur_qty','rate','rate_units','bill_ref','status','comments'],
        fg_inventory:['date','prod_order_id','d_no','ups','sheets','packets','qty','qty_units','qty_wastage','wastage_problem','last_entry','comment','fg_status'],
        delivery_orders:['date','order_id','price','taxation'],
        delivery_order_items:['delivery_order_id','ds_item_pl_id','inv_batch_id','packet_qty'],
        machines:['name','machine_type','processes','location','status','notes'],
      }
      const RULES:Record<string,{ops:string[],fields:string[]}>={
        pro_steps:{ops:['get','insert','update','delete','set_pros'],fields:['process_name','prod_order_id','vendor_id','machine','die_id','plate_id','material_id','seq','step_status','process_status','qty_in','qty_out','wastage','done_by','date','varnish','foil']},
      }
      for(const t of Object.keys(COLS))RULES[t]={ops:['get','insert','update','delete'],fields:COLS[t]}
      // Before a delete: where else this record is used (table, column, which value of the record to look for)
      const REFS:Record<string,[string,string,string][]>={
        accounts:[['orders','customer_id','id'],['orders','transport_id','id'],['products','customer_id','id'],['pro_steps','vendor_id','id'],['rm_list','vendor_id','id'],['rm_in','vendor_id','id'],['purchase_orders','vendor_id','id'],['dies','vendor_id','id']],
        products:[['orders','product_id','id'],['production_orders','product_id','id']],
        orders:[['production_orders','order_id','id'],['delivery_orders','order_id','id']],
        production_orders:[['pro_step_orders','prod_order_id','id'],['fg_inventory','prod_order_id','id']],
        jobs:[['production_orders','job_id','id']],
        dies:[['pro_steps','die_id','id']],
        plates:[['pro_steps','plate_id','id']],
        rm_categories:[['rm_subcategories','category_id','id'],['rm_list','category_id','id'],['rm_in','category_id','id']],
        rm_subcategories:[['rm_list','subcategory_id','id'],['rm_in','subcategory_id','id']],
        rm_list:[['rm_in','rm_item_id','id'],['purchase_orders','rm_id','id']],
        rm_in:[['rm_out','rm_in_id','rm_in_id']],
        purchase_orders:[['rm_in','purchase_id','id']],
        fg_inventory:[['delivery_order_items','inv_batch_id','inv_batch_id']],
        delivery_orders:[['delivery_order_items','delivery_order_id','id']],
        machines:[['pro_steps','machine','name']],
      }
      const LABEL:Record<string,string>={orders:'orders',products:'products',production_orders:'production orders',pro_steps:'processes',pro_step_orders:'processes',rm_list:'RM items',rm_in:'GRNs',rm_out:'RM issues',purchase_orders:'purchase orders',dies:'dies',fg_inventory:'FG batches',delivery_orders:'despatches',delivery_order_items:'despatch items',rm_subcategories:'sub-categories'}
      const rule=RULES[table]
      if(!rule||!rule.ops.includes(op))return J({error:`Not allowed: ${op} on ${table}`},400)
      if(au.role_id!=='owner'){
        const{data:perm}=await supabase.from('role_permissions').select('can_write,can_delete').eq('role_id',au.role_id).eq('resource',table).single()
        const ok=op==='delete'?perm?.can_delete:perm?.can_write // set_pros counts as a write
        if(!ok)return J({error:`Your role (${au.role_id}) cannot ${op==='delete'?'delete':'change'} ${table}`},403)
      }
      const clean:Record<string,any>={}
      for(const k of rule.fields)if(k in data)clean[k]=data[k]===''?null:data[k]
      // PROs for a step (one step can cover several PROs of the SAME job)
      let proIds:string[]|null=null
      if(table==='pro_steps'&&Array.isArray(data.pro_ids)){
        proIds=[...new Set(data.pro_ids.map((x:any)=>String(x)))]
        if(!proIds.length)return J({error:'Select at least one production order'},400)
        const{data:pr}=await supabase.from('production_orders').select('id,job_id').in('id',proIds)
        if(!pr||pr.length!==proIds.length)return J({error:'Some production orders were not found'},400)
        if(new Set(pr.map((x:any)=>x.job_id)).size!==1)return J({error:'All production orders of a process must belong to the same job'},400)
        if(op==='insert'&&!data.prod_order_id)data.prod_order_id=proIds[0]
      }
      const STEP_ST=['pending','in_progress','done','skipped','cancelled']
      const LEGACY:Record<string,string>={pending:'To Send',in_progress:'Part Processed',done:'Moved',skipped:'Skipped',cancelled:'Cancelled'}
      // One status only: process_status holds the sheet's values; step_status is kept in step with it automatically
      const PS_STATE:Record<string,string>={'To Send':'pending','Job Order Sent':'in_progress','Job Approved':'in_progress','Part Processed':'in_progress','Moved':'done','Complete':'done','Cancelled':'cancelled'}
      if(table==='pro_steps'){
        if('process_status' in clean){
          if(!(clean.process_status in PS_STATE))return J({error:'Invalid process status'},400)
          clean.step_status=PS_STATE[clean.process_status]
        }else if('step_status' in clean){
          if(!STEP_ST.includes(clean.step_status))return J({error:'Invalid step status'},400)
          clean.process_status=LEGACY[clean.step_status]
        }
        for(const k of ['seq','qty_in','qty_out','wastage'])if(k in clean&&clean[k]!=null){const n=Number(clean[k]);if(!Number.isFinite(n)||n<0)return J({error:`Invalid ${k}`},400);clean[k]=Math.round(n)}
        if(clean.vendor_id&&clean.machine)return J({error:'A step is either in-house (machine) or outsourced (vendor), not both'},400)
      }
      if(table==='production_orders'&&'pro_status' in clean&&clean.pro_status!=null&&!['planned','in_production','packing','complete','legacy'].includes(clean.pro_status))return J({error:'Invalid PRO status'},400)
      if(table==='jobs'&&'job_type' in clean&&clean.job_type&&!['Machine','Sheet','Tupax','Direct','Direct5'].includes(clean.job_type))return J({error:'Invalid job type'},400)
      if(table==='jobs'&&'status' in clean&&clean.status!=null&&!['planned','in_progress','done'].includes(clean.status))return J({error:'Invalid job status'},400)
      let row:any=null,old:any=null
      if(op!=='insert'){
        if(!id)return J({error:'Missing id'},400)
        const{data:o}=await supabase.from(table).select('*').eq('id',id).single()
        if(!o)return J({error:'Record not found'},404)
        old=o
      }
      if(op==='get')return J({ok:true,row:old})
      // types: blank → null; numbers checked
      if(table!=='pro_steps'){
        for(const k of Object.keys(clean)){const v=clean[k];if(typeof v==='string')clean[k]=v.trim()===''?null:v.trim()}
      }
      if(table==='pro_steps'&&op==='insert'){
        if(!clean.prod_order_id&&proIds)clean.prod_order_id=proIds[0]
        if(!clean.prod_order_id||!clean.process_name)return J({error:'PRO and process are required'},400)
        const{data:pro}=await supabase.from('production_orders').select('id').eq('id',clean.prod_order_id).single()
        if(!pro)return J({error:'PRO not found'},404)
        if(!clean.step_status){clean.step_status='pending';clean.process_status=LEGACY.pending}
        if(!clean.date)clean.date=new Date(Date.now()+19800000).toISOString().slice(0,10)
        for(let i=0;i<3&&!row;i++){
          const{data:nid,error:ie}=await supabase.rpc('next_pro_step_id',{p_proc:clean.process_name})
          if(ie)return J({error:ie.message},500)
          const r=await supabase.from(table).insert({...clean,id:nid}).select().single()
          if(!r.error){row=r.data;await supabase.from('pro_step_orders').insert((proIds||[clean.prod_order_id]).map(pid=>({step_id:nid,prod_order_id:pid})))}
          else if(!String(r.error.message).includes('duplicate'))return J({error:r.error.message},400)
        }
        if(!row)return J({error:'Could not create step id'},500)
      }else if(op==='insert'){
        if(table==='accounts'&&(!clean.name||!clean.account_type))return J({error:'Name and account type are required'},400)
        if(table==='products'&&!clean.product_name)return J({error:'Product name is required'},400)
        if(table==='machines'&&!clean.name)return J({error:'Machine name is required'},400)
        if(COLS[table].includes('date')&&!clean.date)clean.date=new Date(Date.now()+19800000).toISOString().slice(0,10)
        for(let i=0;i<4&&!row;i++){
          const{data:nid,error:ie}=await supabase.rpc('next_app_id',{p_table:table,p_type:table==='accounts'?clean.account_type:table==='jobs'?clean.job_type:null})
          if(ie)return J({error:ie.message},500)
          const rec:any={...clean,id:nid}
          if(table==='rm_in')rec.rm_in_id='RM'+String(nid).padStart(5,'0')
          if(table==='fg_inventory')rec.inv_batch_id='INV_'+nid
          const r=await supabase.from(table).insert(rec).select().single()
          if(!r.error)row=r.data
          else if(!String(r.error.message).includes('duplicate'))return J({error:r.error.message},400)
        }
        if(!row)return J({error:'Could not create a new id'},500)
      }else if(op==='set_pros'){
        if(!proIds)return J({error:'pro_ids required'},400)
        await supabase.from('pro_step_orders').delete().eq('step_id',id)
        const ins=await supabase.from('pro_step_orders').insert(proIds.map(pid=>({step_id:id,prod_order_id:pid})))
        if(ins.error)return J({error:ins.error.message},400)
        const r=await supabase.from(table).update({prod_order_id:proIds[0]}).eq('id',id).select().single()
        if(r.error)return J({error:r.error.message},400)
        row={...r.data,pro_ids:proIds}
      }else if(op==='update'){
        if(!Object.keys(clean).length)return J({error:'Nothing to update'},400)
        if(table==='machines'&&'name' in clean&&clean.name!==old.name){
          const{count}=await supabase.from('pro_steps').select('id',{count:'exact',head:true}).eq('machine',old.name)
          if(count&&count>0)return J({error:'This machine is already used on '+count+' processes, so its name can\'t change (history keeps the old name). Add a new machine instead.'},400)
        }
        if(table==='pro_steps'){
          const v=('vendor_id' in clean)?clean.vendor_id:old.vendor_id, m=('machine' in clean)?clean.machine:old.machine
          if(v&&m){ if('vendor_id' in clean&&clean.vendor_id)clean.machine=null; else if('machine' in clean&&clean.machine)clean.vendor_id=null }
        }
        const r=await supabase.from(table).update(clean).eq('id',id).select().single()
        if(r.error)return J({error:r.error.message},400)
        row=r.data
      }else if(op==='delete'){
        if(table==='pro_steps'){
          if((old.qty_out||0)>0||!['To Send',null,''].includes(old.process_status))return J({error:'Only an unstarted step can be deleted — mark it Cancelled instead'},400)
          const{count}=await supabase.from('rm_out').select('id',{count:'exact',head:true}).eq('prod_proc_id',id)
          if(count&&count>0)return J({error:'Material has been issued against this step — mark it Cancelled instead'},400)
          await supabase.from('pro_step_orders').delete().eq('step_id',id)
        }else{
          const used:string[]=[]
          for(const [t,c,key] of (REFS[table]||[])){
            const val=old[key];if(val==null||val==='')continue
            const{count}=await supabase.from(t).select(t==='pro_step_orders'?'step_id':'id',{count:'exact',head:true}).eq(c,val)
            if(count&&count>0)used.push(count+' '+(LABEL[t]||t))
          }
          if(used.length)return J({error:'Can\'t delete — it is used in '+used.join(', ')+'. Edit it instead.'},400)
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
    const pros=await fetchAll('production_orders','id,date,qty,is_cancelled,is_on_hold,product_id,order_id,job_id,job_name,job_type,imposition_type,sheet_portion_l,sheet_portion_b,sheet_portion_units,sheet_qty,ups,blocks,pro_status,completed_on,wastage_qty,wastage_reason')
    const products=await fetchAll('products','id,product_name,customer_name,design_status,material,size_l,size_b,size_units,category,product_class')
    const accounts=await fetchAll('accounts','id,name,brand,alias,account_type')
    const jobs=await fetchAll('jobs','id,date,job_name,job_type,status')
    const dies=await fetchAll('dies','id,die_name,total_ups,status,die_type')
    const plates=await fetchAll('plates','id,plate_name,status')
    const procs=await fetchAll('pro_steps','id,date,process_name,prod_order_id,material_id,qty_in,qty_out,step_status,process_status,vendor_id,machine,die_id,plate_id,wastage,seq,done_by')
    const step_links=await fetchAll('pro_step_orders','step_id,prod_order_id','id')
    const rm_cats=await fetchAll('rm_categories','id,name','id')
    const rm_subcats=await fetchAll('rm_subcategories','id,name,category_id','id')
    const rm_list=await fetchAll('rm_list','id,alias,brand,category_id,subcategory_id,vendor_id','id')
    const rm_in=await fetchAll('rm_in','id,rm_in_id,date,rm_item_id,vendor_id,qty,qty_units,vendor_ref,status,category_id,subcategory_id,purchase_id,recd_date,freight_amt,carton_no','rm_in_id')
    const rm_out=await fetchAll('rm_out','id,date,rm_in_id,prod_proc_id,out_for,qty','id')
    const fg_inv=await fetchAll('fg_inventory','id,date,prod_order_id,inv_batch_id,d_no,ups,sheets,packets,qty,qty_units,qty_wastage,last_entry,fg_status','id')
    const dos=await fetchAll('delivery_orders','id,date,order_id,price,taxation')
    const do_items=await fetchAll('delivery_order_items','id,delivery_order_id,ds_item_pl_id,inv_batch_id,packet_qty','id')
    const machines=await fetchAll('machines','id,name,machine_type,processes,location,status,notes')
    const pos=await fetchAll('purchase_orders','id,date,rm_id,vendor_id,pur_qty,rate,pur_unit,rate_units,status,bill_ref,comments')
    return new Response(JSON.stringify({machines,orders,pros,products,accounts,jobs,dies,plates,procs,step_links,rm_cats,rm_subcats,rm_list,rm_in,rm_out,fg_inv,dos,do_items,pos,_counts:{orders:orders.length,pros:pros.length,products:products.length,accounts:accounts.length,jobs:jobs.length,procs:procs.length,rm_in:rm_in.length,fg_inv:fg_inv.length,dos:dos.length}}),{headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}})
  }catch(err:any){
    return new Response(JSON.stringify({error:err.message}),{status:500,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}})
  }
})
