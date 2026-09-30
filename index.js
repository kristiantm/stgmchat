const MODULE = 'adventure_director';
const META_KEY = 'adventure_director_v1';

const DEFAULT_SYSTEM = `You are the private GM / director / continuity editor for the current SillyTavern role-play. You are NOT speaking in the public adventure unless the user explicitly asks you to draft text for it. Help the user inspect continuity, character motivations, pacing, world facts, prompts, lore and role-play setup. Treat the current adventure as canon. Distinguish observed canon from suggestions. When asked to rewrite a prompt or field, preserve established facts unless explicitly asked to change them. Be concise and practical.`;

let root, panel, resizer, toggle, activeTab = 'chat', busy = false, pendingEdit = null, resultView = 'proposed';

function ctx(){ return SillyTavern.getContext(); }
function toast(type, msg){ try { globalThis.toastr?.[type]?.(msg, 'Adventure Director'); } catch {} }
function esc(s=''){ return String(s).replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[c])); }

function settings(){
  const c = ctx();
  c.extensionSettings[MODULE] ??= {};
  const s = c.extensionSettings[MODULE];
  s.systemPrompt ??= DEFAULT_SYSTEM;
  s.width ??= 390;
  s.collapsed ??= true;
  s.mode ??= 'gm';
  s.lastTarget ??= 'author_note';
  s.lastField ??= 'description';
  return s;
}
function saveSettings(){ ctx().saveSettingsDebounced(); }
function meta(){
  const c=ctx();
  c.chatMetadata[META_KEY] ??= { history: [] };
  c.chatMetadata[META_KEY].history ??= [];
  return c.chatMetadata[META_KEY];
}
async function saveMeta(){ await ctx().saveMetadata(); }

function getCharacters(){ return (ctx().characters||[]).filter(Boolean); }
function characterName(ch){ return ch?.name || ch?.data?.name || 'Character'; }
function characterData(ch){ return ch?.data || ch || {}; }
function activeCharacter(){ const c=ctx(); return c.characterId !== undefined && c.characterId !== null ? c.characters?.[Number(c.characterId)] : null; }

function modeOptions(){
  const s=settings();
  const chars=getCharacters();
  const out=[['gm','GM / Director'],['narrator','Narrator / RP context']];
  chars.forEach((ch,i)=>out.push([`char:${i}`, characterName(ch)]));
  return out.map(([v,l])=>`<option value="${esc(v)}" ${s.mode===v?'selected':''}>${esc(l)}</option>`).join('');
}

function modeSystem(){
  const s=settings();
  if(s.mode==='gm') return s.systemPrompt;
  if(s.mode==='narrator') return `${s.systemPrompt}\n\nMODE: Narrator. Discuss the story from the narrator/director perspective. Do not add a public chat message unless asked to draft one.`;
  if(s.mode.startsWith('char:')){
    const ch=getCharacters()[Number(s.mode.split(':')[1])];
    const d=characterData(ch);
    return `${s.systemPrompt}\n\nMODE: Private character consultation. Reason from the selected character's established perspective and knowledge, but stay in a private OOC consultation. Do not pretend the character knows information they have not learned.\n\nSELECTED CHARACTER: ${characterName(ch)}\nDescription: ${d.description||''}\nPersonality: ${d.personality||''}\nScenario: ${d.scenario||''}\nCharacter system prompt: ${d.system_prompt||''}\nPost-history instructions: ${d.post_history_instructions||''}`;
  }
  return s.systemPrompt;
}

// Separates model reasoning from the answer. Uses ST's own parser (which follows the user's reasoning
// template, e.g. Gemma's <|channel>thought … <channel|>) even when auto-parse is off, then falls back
// to common <think> tags and to a truncated reply that opened reasoning but never closed it.
function splitReasoning(raw){
  const text=String(raw||'').trim();
  const c=ctx();
  try{ const r=c.parseReasoningFromString?.(text); if(r?.reasoning) return {reasoning:r.reasoning.trim(),content:String(r.content||'').trim()}; }catch{}
  const m=text.match(/^<(think|thinking)>([\s\S]*?)(?:<\/\1>|$)([\s\S]*)$/i);
  if(m) return {reasoning:m[2].trim(),content:m[3].trim()};
  const prefix=c.powerUserSettings?.reasoning?.prefix?.trim();
  if(prefix && text.startsWith(prefix)) return {reasoning:text.slice(prefix.length).trim(),content:''};
  return {reasoning:'',content:text};
}
function formatMarkdown(text){
  try{ return ctx().messageFormatting(text,'Director',true,false,-1); }catch{ return esc(text); }
}

function historyPrompt(){
  const h=meta().history.slice(-12);
  if(!h.length) return '';
  return '\n\nPRIVATE GM-CONSOLE HISTORY:\n' + h.map(m=>`${m.role==='user'?'User':'GM'}: ${m.role==='user'?m.content:splitReasoning(m.content).content}`).join('\n\n');
}

async function generateGM(userText){
  const c=ctx();
  // generateQuietPrompt deliberately uses SillyTavern's current active API/model/settings and current chat context.
  const instruction = `${modeSystem()}${historyPrompt()}\n\nCURRENT PRIVATE USER REQUEST:\n${userText}\n\nAnswer only in the private GM console.`;
  return await c.generateQuietPrompt({ quietPrompt: instruction });
}

function renderMessage(m){
  if(m.role==='user') return `<div class="ad-msg ad-user"><div class="ad-meta">You</div>${esc(m.content)}</div>`;
  // Older entries stored the raw reply, so split on render as well as on save.
  const split=m.reasoning!==undefined ? {reasoning:m.reasoning,content:m.content} : splitReasoning(m.content);
  const reasoning=split.reasoning ? `<details class="ad-reasoning"><summary>Reasoning</summary><div>${esc(split.reasoning)}</div></details>` : '';
  const body=split.content ? formatMarkdown(split.content) : '<span class="ad-small">(No answer — the model only returned reasoning.)</span>';
  return `<div class="ad-msg ad-assistant"><div class="ad-meta">Director</div>${reasoning}<div class="ad-body">${body}</div></div>`;
}
function renderHistory(){
  const log=document.querySelector('#ad-chat-log'); if(!log) return;
  const h=meta().history;
  const pending=busy==='chat' ? '<div class="ad-msg ad-assistant ad-pending"><div class="ad-meta">Director</div>Thinking…</div>' : '';
  log.innerHTML=h.length||pending ? h.map(renderMessage).join('')+pending : `<div class="ad-small">This private history is empty. It is stored per adventure chat and never appears in the role-play transcript.</div>`;
  log.scrollTop=log.scrollHeight;
}

async function sendGM(){
  if(busy) return;
  const input=document.querySelector('#ad-input');
  const text=input.value.trim(); if(!text) return;
  setBusy('chat');
  meta().history.push({role:'user',content:text,ts:Date.now()});
  input.value=''; renderHistory(); await saveMeta();
  try{
    const {reasoning,content}=splitReasoning(await generateGM(text));
    meta().history.push({role:'assistant',content,reasoning,ts:Date.now()});
    await saveMeta();
  }catch(e){ console.error('[Adventure Director] generation failed',e); toast('error', e?.message||'Generation failed'); }
  finally{ setBusy(false); renderHistory(); }
}

async function clearHistory(){
  if(!confirm('Clear only the private GM-console history for this adventure? The role-play chat and all SillyTavern data will remain unchanged.')) return;
  meta().history=[]; pendingEdit=null; await saveMeta(); renderHistory(); renderPreview(); toast('success','GM history cleared');
}

// busy is false, 'chat' or 'rewrite'; progress shows on the button that started the request.
function setBusy(kind){
  busy=kind;
  const send=document.querySelector('#ad-send'), propose=document.querySelector('#ad-propose');
  if(send){ send.disabled=!!kind; send.textContent=kind==='chat'?'…':'Send'; }
  if(propose){ propose.disabled=!!kind; propose.textContent=kind==='rewrite'?'Rewriting…':'Ask Director to rewrite'; }
}
function switchTab(tab){ activeTab=tab; document.querySelectorAll('.ad-tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab)); document.querySelectorAll('.ad-view').forEach(v=>v.classList.toggle('active',v.dataset.view===tab)); if(tab==='edit') refreshEditor(); }

function getAuthorNote(){
  const md=ctx().chatMetadata||{};
  return md.note_prompt ?? md.author_note ?? document.querySelector('#extension_floating_prompt')?.value ?? '';
}
function getPersona(){
  const c=ctx();
  return c.powerUserSettings?.persona_description ?? c.power_user?.persona_description ?? document.querySelector('#persona_description')?.value ?? '';
}

function getCurrentValue(target, field){
  if(target==='author_note') return getAuthorNote();
  if(target==='persona') return getPersona();
  if(target.startsWith('character:')){
    const ch=getCharacters()[Number(target.split(':')[1])]; const d=characterData(ch);
    return d?.[field] ?? ch?.[field] ?? '';
  }
  return '';
}

function editorTargetOptions(){
  const opts=[['author_note',"Author's Note"],['persona','Persona description']];
  getCharacters().forEach((ch,i)=>opts.push([`character:${i}`,`Character: ${characterName(ch)}`]));
  return opts.map(([v,l])=>`<option value="${esc(v)}">${esc(l)}</option>`).join('');
}
function characterFieldOptions(){
  const f=[['description','Description'],['personality','Personality'],['scenario','Scenario'],['system_prompt','System prompt'],['post_history_instructions','Post-history instructions'],['first_mes','First message'],['mes_example','Example dialogue']];
  return f.map(([v,l])=>`<option value="${v}">${l}</option>`).join('');
}

function refreshEditor(){
  const target=document.querySelector('#ad-edit-target'); if(!target) return;
  const s=settings();
  target.innerHTML=editorTargetOptions();
  if([...target.options].some(o=>o.value===s.lastTarget)) target.value=s.lastTarget;
  const field=document.querySelector('#ad-edit-field'); field.innerHTML=characterFieldOptions(); field.value=s.lastField||'description';
  syncEditorValue();
}
function syncEditorValue(){
  const target=document.querySelector('#ad-edit-target')?.value || 'author_note';
  const isChar=target.startsWith('character:');
  document.querySelector('#ad-char-field-wrap')?.classList.toggle('ad-hidden',!isChar);
  const field=document.querySelector('#ad-edit-field')?.value||'description';
  const val=getCurrentValue(target,field);
  const src=document.querySelector('#ad-current-value'); if(src) src.value=val;
  updateCurrentCount();
  settings().lastTarget=target; settings().lastField=field; saveSettings();
  pendingEdit=null; renderPreview();
}
function updateCurrentCount(){
  const n=document.querySelector('#ad-current-value')?.value.length||0;
  const el=document.querySelector('#ad-current-count'); if(el) el.textContent=n?`· ${n.toLocaleString()} chars`:'· empty';
}

async function proposeRewrite(){
  if(busy) return;
  const target=document.querySelector('#ad-edit-target').value;
  const field=document.querySelector('#ad-edit-field').value;
  const current=document.querySelector('#ad-current-value').value;
  const instruction=document.querySelector('#ad-edit-instruction').value.trim();
  if(!instruction){ toast('warning','Describe how you want it rewritten'); return; }
  setBusy('rewrite');
  const label=target==='author_note'?"Author's Note":target==='persona'?'Persona description':`${characterName(getCharacters()[Number(target.split(':')[1])])} — ${field}`;
  const prompt=`Rewrite the following SillyTavern field. Return ONLY the complete replacement text, with no explanation, markdown fence, labels, or commentary.\n\nTARGET: ${label}\nUSER REQUEST: ${instruction}\n\nCURRENT TEXT:\n${current}`;
  try{
    // Strip reasoning first, or Apply would write the model's thinking into the field.
    const {content}=splitReasoning(await generateGM(prompt));
    if(!content) throw new Error('The model returned only reasoning and no rewritten text. Try again.');
    const proposed=content.replace(/^```[a-z]*\n?/i,'').replace(/```$/,'').trim();
    pendingEdit={target,field,before:current,after:proposed}; renderPreview();
  }catch(e){ console.error(e); toast('error',e?.message||'Rewrite failed'); }
  finally{ setBusy(false); }
}
function renderPreview(){
  const result=document.querySelector('#ad-result'), actions=document.querySelector('#ad-actions'); if(!result||!actions) return;
  result.classList.toggle('ad-hidden',!pendingEdit); actions.classList.toggle('ad-hidden',!pendingEdit);
  if(!pendingEdit) return;
  document.querySelector('#ad-proposed').value=pendingEdit.after;
  setResultView(resultView);
}
function setResultView(view){
  resultView=view;
  document.querySelectorAll('[data-result-view]').forEach(b=>b.classList.toggle('active',b.dataset.resultView===view));
  document.querySelector('#ad-proposed').classList.toggle('ad-hidden',view!=='proposed');
  const diff=document.querySelector('#ad-diff'); diff.classList.toggle('ad-hidden',view!=='diff');
  if(view==='diff' && pendingEdit) diff.innerHTML=diffHtml(pendingEdit.before,pendingEdit.after);
}

// Word-level diff: trim the shared prefix/suffix, then LCS the middle. Very large middles
// (a full rewrite of a long card) skip the LCS and show as one removal plus one insertion.
function diffHtml(before,after){
  if(before===after) return '<span class="ad-small">No changes.</span>';
  // Punctuation gets its own tokens so `"caring",` → `"fierce",` marks only the word.
  const tokens=s=>s.split(/(\s+|[^\p{L}\p{N}_\s])/u).filter(Boolean);
  const a=tokens(before), b=tokens(after);
  let pre=0; while(pre<a.length&&pre<b.length&&a[pre]===b[pre]) pre++;
  let suf=0; while(suf<a.length-pre&&suf<b.length-pre&&a[a.length-1-suf]===b[b.length-1-suf]) suf++;
  const A=a.slice(pre,a.length-suf), B=b.slice(pre,b.length-suf);
  const ops=[['same',a.slice(0,pre).join('')]];
  if(A.length*B.length>2_000_000){ ops.push(['del',A.join('')],['ins',B.join('')]); }
  else{
    const w=B.length+1, L=new Uint32Array((A.length+1)*w);
    for(let i=A.length-1;i>=0;i--) for(let j=B.length-1;j>=0;j--) L[i*w+j]=A[i]===B[j]?L[(i+1)*w+j+1]+1:Math.max(L[(i+1)*w+j],L[i*w+j+1]);
    let i=0,j=0;
    while(i<A.length||j<B.length){
      if(i<A.length&&j<B.length&&A[i]===B[j]){ ops.push(['same',A[i++]]); j++; }
      else if(i<A.length&&(j>=B.length||L[(i+1)*w+j]>=L[i*w+j+1])) ops.push(['del',A[i++]]);
      else ops.push(['ins',B[j++]]);
    }
  }
  ops.push(['same',a.slice(a.length-suf).join('')]);
  const tag={same:s=>esc(s),ins:s=>`<ins>${esc(s)}</ins>`,del:s=>`<del>${esc(s)}</del>`};
  let html='', run='', kind='same';
  for(const [k,s] of ops){ if(!s) continue; if(k!==kind){ html+=tag[kind](run); run=''; kind=k; } run+=s; }
  return html+tag[kind](run);
}

async function executeSlash(command){
  const c=ctx();
  if(typeof c.executeSlashCommandsWithOptions==='function') return c.executeSlashCommandsWithOptions(command,{handleParserErrors:true,handleExecutionErrors:true});
  if(typeof c.executeSlashCommands==='function') return c.executeSlashCommands(command);
  throw new Error('Slash command API unavailable in this SillyTavern build.');
}
function slashQuote(text){ return String(text).replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\|/g,'¦').replace(/\r?\n/g,'\\n'); }

async function applyAuthorNote(text){
  // /note is the native chat-scoped Author's Note command; replacing | avoids STscript command chaining.
  await executeSlash(`/note "${slashQuote(text)}"`);
}
async function applyPersona(text){
  const el=document.querySelector('#persona_description, textarea[name="persona_description"]');
  if(!el) throw new Error('Open the Persona editor once, then retry Apply. SillyTavern did not expose an editable persona field in the current UI.');
  el.value=text; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
  // Many builds save through the existing change/input handler; leave persistence to ST's native persona editor.
}

const FIELD_SELECTORS={
  description:['#description_textarea','#description_pole','textarea[name="description"]'],
  personality:['#personality_textarea','#personality_pole','textarea[name="personality"]'],
  scenario:['#scenario_pole','#scenario_textarea','textarea[name="scenario"]'],
  system_prompt:['#system_prompt_textarea','#system_prompt','textarea[name="system_prompt"]'],
  post_history_instructions:['#post_history_instructions_textarea','#post_history_instructions','textarea[name="post_history_instructions"]'],
  first_mes:['#firstmessage_textarea','#first_mes','textarea[name="first_mes"]'],
  mes_example:['#mes_example_textarea','#mes_example','textarea[name="mes_example"]']
};
async function applyCharacter(target,field,text){
  const idx=Number(target.split(':')[1]);
  const c=ctx();
  if(Number(c.characterId)!==idx) throw new Error('For safety, switch the main SillyTavern chat/editor to this character before applying the change. The GM can consult any character, but v1 only writes to the actively selected character.');
  const selectors=FIELD_SELECTORS[field]||[];
  let el=null; for(const sel of selectors){ el=document.querySelector(sel); if(el) break; }
  if(!el) throw new Error(`Open this character's Advanced Definitions/editor, then retry Apply. I could not find SillyTavern's ${field} editor control in this build.`);
  el.value=text; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
  // Try native save controls, without depending on a single release-specific selector.
  const save=document.querySelector('#create_button, #character_edit_button, #save_character, [data-i18n="Save"].menu_button, button[title*="Save character" i]');
  if(save && !save.disabled) save.click();
}

async function applyPending(){
  if(!pendingEdit) return;
  if(!confirm('Apply this proposed replacement to SillyTavern?')) return;
  try{
    if(pendingEdit.target==='author_note') await applyAuthorNote(pendingEdit.after);
    else if(pendingEdit.target==='persona') await applyPersona(pendingEdit.after);
    else await applyCharacter(pendingEdit.target,pendingEdit.field,pendingEdit.after);
    toast('success','Change applied');
    document.querySelector('#ad-current-value').value=pendingEdit.after; updateCurrentCount(); pendingEdit=null; renderPreview();
  }catch(e){ console.error('[Adventure Director] apply failed',e); toast('error',e?.message||'Could not apply'); }
}
function copyPending(){ if(!pendingEdit)return; navigator.clipboard.writeText(pendingEdit.after).then(()=>toast('success','Proposed text copied')); }

function buildUI(){
  root=document.createElement('div'); root.id='ad-root';
  root.innerHTML=`<div id="ad-panel">
    <div id="ad-head"><div id="ad-title">Adventure Director</div><select id="ad-mode" class="text_pole" title="Who you are consulting">${modeOptions()}</select><button id="ad-settings-toggle" class="ad-icon-btn" title="Settings">⚙</button><button id="ad-close" class="ad-icon-btn" title="Collapse">◀</button></div>
    <div id="ad-settings" class="ad-hidden">
      <label class="ad-small" for="ad-system">Extra private system prompt</label><textarea id="ad-system" class="text_pole">${esc(settings().systemPrompt)}</textarea>
      <div class="ad-row"><button id="ad-edit-system" class="menu_button">Reset prompt</button><button id="ad-clear" class="menu_button ad-danger">Clear GM history</button></div>
    </div>
    <div id="ad-tabs"><button class="ad-tab active" data-tab="chat">GM chat</button><button class="ad-tab" data-tab="edit">Edit setup</button></div>
    <section class="ad-view active" data-view="chat"><div id="ad-chat-log"></div><div id="ad-compose"><textarea id="ad-input" class="text_pole" placeholder="Ask the GM/director… (Ctrl+Enter to send)"></textarea><button id="ad-send" class="menu_button">Send</button></div></section>
    <section class="ad-view" data-view="edit"><div id="ad-editor">
      <div class="ad-row ad-targets">
        <div class="ad-field"><label class="ad-small" for="ad-edit-target">Target</label><select id="ad-edit-target" class="text_pole"></select></div>
        <div class="ad-field" id="ad-char-field-wrap"><label class="ad-small" for="ad-edit-field">Field</label><select id="ad-edit-field" class="text_pole"></select></div>
      </div>
      <div class="ad-field"><label class="ad-small" for="ad-edit-instruction">What should change?</label><textarea id="ad-edit-instruction" class="text_pole" placeholder="E.g. Make her more guarded and less overtly flirtatious, without changing established backstory. (Ctrl+Enter)"></textarea></div>
      <button id="ad-propose" class="menu_button">Ask Director to rewrite</button>
      <details id="ad-current-wrap"><summary>Current text <span id="ad-current-count" class="ad-small"></span></summary>
        <textarea id="ad-current-value" class="text_pole"></textarea>
        <div class="ad-small">The Director rewrites from this text. Editing it here does not change SillyTavern.</div>
      </details>
      <div id="ad-result" class="ad-hidden">
        <div class="ad-result-head"><span>Proposal</span><div class="ad-seg"><button data-result-view="proposed" class="active">Edit</button><button data-result-view="diff">Diff</button></div></div>
        <textarea id="ad-proposed" class="text_pole"></textarea>
        <div id="ad-diff" class="ad-hidden"></div>
      </div>
    </div>
    <div id="ad-actions" class="ad-hidden"><button id="ad-copy" class="menu_button">Copy</button><button id="ad-discard" class="menu_button">Discard</button><button id="ad-apply" class="menu_button" title="Asks for confirmation first. Character and persona writes go through SillyTavern's own editor, so it must be open for the active character.">Apply</button></div>
    </section>
  </div><div id="ad-resizer"></div>`;
  document.body.append(root);
  toggle=document.createElement('button'); toggle.id='ad-toggle'; toggle.title='Adventure Director'; toggle.textContent='🎬'; document.body.append(toggle);
  applyCollapsed(settings().collapsed);
  document.documentElement.style.setProperty('--ad-width',`${settings().width}px`);

  document.querySelector('#ad-close').onclick=()=>applyCollapsed(true);
  toggle.onclick=()=>applyCollapsed(!root.classList.contains('ad-collapsed'));
  document.querySelector('#ad-clear').onclick=clearHistory;
  document.querySelector('#ad-send').onclick=sendGM;
  document.querySelector('#ad-input').addEventListener('keydown',e=>{ if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();sendGM();} });
  document.querySelector('#ad-mode').onchange=e=>{settings().mode=e.target.value;saveSettings();};
  document.querySelector('#ad-system').onchange=e=>{settings().systemPrompt=e.target.value;saveSettings();};
  document.querySelector('#ad-edit-system').onclick=()=>{ if(confirm('Reset the GM system prompt to the default?')){settings().systemPrompt=DEFAULT_SYSTEM;document.querySelector('#ad-system').value=DEFAULT_SYSTEM;saveSettings();} };
  document.querySelector('#ad-settings-toggle').onclick=()=>{ const open=document.querySelector('#ad-settings').classList.toggle('ad-hidden')===false; document.querySelector('#ad-settings-toggle').classList.toggle('active',open); };
  document.querySelectorAll('.ad-tab').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));
  document.querySelector('#ad-edit-target').onchange=syncEditorValue;
  document.querySelector('#ad-edit-field').onchange=syncEditorValue;
  document.querySelector('#ad-propose').onclick=proposeRewrite;
  document.querySelector('#ad-edit-instruction').addEventListener('keydown',e=>{ if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();proposeRewrite();} });
  document.querySelector('#ad-current-value').addEventListener('input',updateCurrentCount);
  // Hand edits to the proposal are what Apply/Copy use.
  document.querySelector('#ad-proposed').addEventListener('input',e=>{ if(pendingEdit) pendingEdit.after=e.target.value; });
  document.querySelectorAll('[data-result-view]').forEach(b=>b.onclick=()=>setResultView(b.dataset.resultView));
  document.querySelector('#ad-apply').onclick=applyPending;
  document.querySelector('#ad-copy').onclick=copyPending;
  document.querySelector('#ad-discard').onclick=()=>{pendingEdit=null;renderPreview();};
  setupResize(); renderHistory(); refreshEditor();
}
// The floating toggle only opens the panel; while open, the header's ◀ collapses it.
function applyCollapsed(v){ settings().collapsed=!!v; root?.classList.toggle('ad-collapsed',!!v); toggle.classList.toggle('ad-hidden',!v); if(!v) refreshLists(); saveSettings(); }
function refreshLists(){ const m=document.querySelector('#ad-mode'); if(m){ m.innerHTML=modeOptions(); if([...m.options].some(o=>o.value===settings().mode)) m.value=settings().mode; } if(activeTab==='edit') refreshEditor(); }
function setupResize(){
  resizer=document.querySelector('#ad-resizer'); let dragging=false;
  resizer.addEventListener('pointerdown',e=>{ dragging=true; resizer.setPointerCapture(e.pointerId); });
  resizer.addEventListener('pointermove',e=>{ if(!dragging)return; const w=Math.max(300,Math.min(700,e.clientX)); document.documentElement.style.setProperty('--ad-width',`${w}px`); settings().width=w; });
  resizer.addEventListener('pointerup',()=>{dragging=false;saveSettings();});
}
function onChatChanged(){ pendingEdit=null; renderHistory(); refreshLists(); }

export async function init(){
  if(document.querySelector('#ad-root')) return;
  buildUI();
  const c=ctx();
  if(c.eventSource && c.eventTypes?.CHAT_CHANGED) c.eventSource.on(c.eventTypes.CHAT_CHANGED,onChatChanged);
  if(c.eventSource && c.eventTypes?.CHARACTER_EDITED) c.eventSource.on(c.eventTypes.CHARACTER_EDITED,()=>activeTab==='edit'&&refreshEditor());
  // Replaces the old manual ↻ button: keep the mode/target lists in sync when characters come and go.
  for(const ev of ['CHARACTER_DELETED','CHARACTER_RENAMED','CHARACTER_PAGE_LOADED']) if(c.eventSource && c.eventTypes?.[ev]) c.eventSource.on(c.eventTypes[ev],refreshLists);
  console.log('[Adventure Director] loaded');
}
