import { FormEvent, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

// Vite proxies these paths through the local SSH tunnel in development, so the
// browser always talks to the same origin as the panel.
const API_URL = import.meta.env.VITE_API_URL ?? '';

type Keyword = {label:string; query:string};
const sources: Record<string, {name:string; icon:string}> = {'coverr':{name:'Coverr',icon:'▶'}, 'yandex-images':{name:'Яндекс',icon:'Я'}, 'google-images':{name:'Google',icon:'G'}};
type Project = { id: string; news_text: string; created_at: string };
type LibraryAsset = { id: string; original_name: string; mime_type: string; tags: string[]; url: string };
type SourceCredit = { source_provider: string; source_url: string; source_author?: string; source_license?: string };
type RemoteMedia = { id: string; kind: 'video' | 'photo'; title: string; previewUrl: string; provider: string; sourceUrl: string; author?: string; license?: string; query: string };

function App() {
  const [newsText, setNewsText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [assetInputKey, setAssetInputKey] = useState(0);
  const [status, setStatus] = useState('Сервер не проверен');
  const [outputUrl, setOutputUrl] = useState<string>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const [libraryQuery, setLibraryQuery] = useState('');
  const [library, setLibrary] = useState<LibraryAsset[]>([]);
  const [selectedLibraryIds, setSelectedLibraryIds] = useState<string[]>([]);
  const [libraryFile, setLibraryFile] = useState<File>();
  const [libraryTags, setLibraryTags] = useState('');
  const [sourceCredits, setSourceCredits] = useState<SourceCredit[]>([]);
  const [remoteMedia, setRemoteMedia] = useState<RemoteMedia[] | undefined>();
  const [selectedRemoteIds, setSelectedRemoteIds] = useState<string[]>([]);
  const [mediaTab, setMediaTab] = useState<'video' | 'photo'>('video');
  const [articleUrl, setArticleUrl] = useState('');
  const [searching, setSearching] = useState(false);
  const [connectionError, setConnectionError] = useState<string>();

  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [keywordError, setKeywordError] = useState('');
  const [keywordMode, setKeywordMode] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [providerPage, setProviderPage] = useState(1);
  const [displayPage, setDisplayPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [topicFilter, setTopicFilter] = useState('');
  const [analysisAttempt, setAnalysisAttempt] = useState(0);
  const [workflow, setWorkflow] = useState<'edit'|'select'|'render'>('edit');
  const [renderError, setRenderError] = useState('');

  useEffect(() => {
    const abort = new AbortController();
    setKeywords([]); setKeywordError(''); setKeywordMode('');
    if (newsText.trim().length < 20) {setAnalyzing(false); return;}
    setAnalyzing(true);
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`${API_URL}/api/keywords`, {method:'POST', headers:{'content-type':'application/json'},body:JSON.stringify({newsText}),signal:abort.signal});
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? 'Не удалось разобрать текст');
        if (!abort.signal.aborted) {setKeywords(data.keywords);setKeywordMode('Темы выделены локальной нейросетью');}
      } catch(error) {if (!abort.signal.aborted) setKeywordError(error instanceof Error?error.message:'Ошибка анализа');}
      finally {if (!abort.signal.aborted) setAnalyzing(false);}
    }, 900);
    return () => {abort.abort();window.clearTimeout(timer);};
  }, [newsText, analysisAttempt]);

  async function fetchMedia(page:number, append=false) {
    const response = await fetch(`${API_URL}/api/media/search`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({newsText,keywords:keywords.filter(k=>k.query.trim()),page}),signal:AbortSignal.timeout(150000)});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? `Поиск: HTTP ${response.status}`);
    setRemoteMedia(previous => {
      const unique = new Map<string,RemoteMedia>();
      for (const item of [...(append ? previous ?? []:[]),...data.items] as RemoteMedia[]) {
        const key=item.previewUrl.split('?')[0].replace('/small_2x/','/small/');
        if (!unique.has(key)) unique.set(key,item);
      }
      return [...unique.values()];
    });
    setWarnings(data.warnings ?? []); setHasMore(data.hasMore); setProviderPage(page);
    return data.items.length;
  }
  async function loadMore() {
    setLoadingMore(true);
    try {const count=await fetchMedia(providerPage+1,true); if(!count)setWarnings(['Источник больше не вернул результатов. Измените запрос или выберите другую тему.']);}
    catch(error){setWarnings([error instanceof Error?error.message:'Не удалось загрузить следующую страницу']);}
    finally{setLoadingMore(false);}
  }

  async function refreshProjects() {
    const response = await fetch(`${API_URL}/api/projects`);
    const result = await response.json();
    setProjects(Array.isArray(result) ? result : []);
    if (!response.ok) setStatus(result.error ?? 'Не удалось загрузить проекты');
  }

  async function searchLibrary(query = libraryQuery) {
    const response = await fetch(`${API_URL}/api/library/search?q=${encodeURIComponent(query)}`);
    const result = await response.json();
    setLibrary(Array.isArray(result) ? result : []);
    if (!response.ok) setStatus('Библиотека станет доступна после обновления backend');
  }

  async function checkConnection() {
    setConnectionError(undefined);
    setStatus('Проверяю связь с сервером…');
    try {
      const response = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(8_000) });
      const health = await response.json() as { stockSearch?: { wikimediaCommons?: boolean; pexels?: boolean } };
      const stockReady = health.stockSearch?.wikimediaCommons || health.stockSearch?.pexels;
      setStatus(response.ok ? (stockReady ? 'Сервер подключён · автопоиск медиа включён' : 'Сервер подключён · включи Wikimedia Commons или добавь PEXELS_API_KEY') : 'Сервер недоступен');
      if (!response.ok) setConnectionError(`Сервер вернул HTTP ${response.status}.`);
      if (response.ok) { void refreshProjects(); void searchLibrary(''); }
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'Туннель не ответил за 8 секунд.' : 'Не удалось подключиться к локальному туннелю.';
      setStatus('Сервер недоступен');
      setConnectionError(`${reason} Проверь, что SSH-туннель на 127.0.0.1:18080 запущен.`);
    }
  }

  useEffect(() => {
    void checkConnection();
  }, []);

  async function startRender(event: FormEvent) {
    event.preventDefault();
    if (!newsText.trim()) {
      setStatus('Вставь текст новости — ссылка на статью необязательна');
      return;
    }
    setSearching(true);
    setConnectionError(undefined);
    try {
    setStatus('Создаю проект…');
    const project = activeProjectId
      ? await fetch(`${API_URL}/api/projects/${activeProjectId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newsText }), signal: AbortSignal.timeout(20_000) }).then((r) => r.json())
      : await fetch(`${API_URL}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newsText }), signal: AbortSignal.timeout(20_000) }).then((r) => r.json());
    if (project.error) return setStatus(project.error);
    setActiveProjectId(project.id);
    for (const file of files) {
      const data = new FormData();
      data.append('file', file);
      const upload = await fetch(`${API_URL}/api/projects/${project.id}/assets`, { method: 'POST', body: data }).then((r) => r.json());
      if (upload.error) return setStatus(upload.error);
    }
    if (files.length) {
      setFiles([]);
      setAssetInputKey((value) => value + 1);
    }
    for (const assetId of selectedLibraryIds) {
      await fetch(`${API_URL}/api/projects/${project.id}/assets/from-library`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assetId }) });
    }
    setStatus('Ищу материалы в открытых источниках…');
    const count = await fetchMedia(1);
    setSelectedRemoteIds([]);setDisplayPage(1);setTopicFilter('');
    setWorkflow('select');
    setStatus(count ? 'Шаг 2 из 3: выберите кадры' : 'Поиск завершён: добавьте или измените тему, для которой нет результата.');
    void refreshProjects();
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        setStatus('Сервер не ответил вовремя');
        setConnectionError('Запрос к серверу превысил лимит времени. Туннель открыт, но сервер или внешний поиск отвечает слишком долго.');
      } else if (error instanceof TypeError) {
        setStatus('Нет соединения с сервером');
        setConnectionError('Браузер не может обратиться к локальному туннелю. Нажми «Проверить связь»; если ошибка остаётся, туннель будет переподнят.');
      } else {
        setStatus('Не удалось создать проект или найти материалы');
        setConnectionError(error instanceof Error ? error.message : 'Неизвестная ошибка запроса.');
      }
    } finally { setSearching(false); }
  }

  async function importArticle() {
    if (!articleUrl) return;
    setStatus('Загружаю текст и обложку статьи…');
    try {
      const result = await fetch(`${API_URL}/api/articles/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: articleUrl }), signal: AbortSignal.timeout(35_000) }).then((response) => response.json());
      if (result.error) return setStatus(result.error);
      setNewsText(result.text);
      setStatus('Статья загружена: проверь текст и найди кадры');
    } catch { setStatus('Не удалось загрузить статью'); }
  }

  async function startMontage() {
    if (!activeProjectId) return;
    try {
    setRenderError('');
    setStatus('Скачиваю выбранные кадры на сервер…');
    const imported = await fetch(`${API_URL}/api/projects/${activeProjectId}/assets/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mediaIds: selectedRemoteIds }), signal: AbortSignal.timeout(120_000) }).then((r) => r.json());
    if (imported.error) { setRenderError(`${imported.error}${imported.failed?.length ? ` ${imported.failed.join('; ')}` : ''}`); return; }
    if (imported.failed?.length) setStatus(`Скачано ${imported.imported}; часть источников недоступна, продолжаю сборку…`);
    setRemoteMedia(undefined);
    setWorkflow('render');
    const job = await fetch(`${API_URL}/api/projects/${activeProjectId}/render`, { method: 'POST', signal: AbortSignal.timeout(20_000) }).then((r) => r.json());
    if (job.error) return setStatus(job.error);
    setStatus('Ролик собирается: раскадровка…');
    const poll = window.setInterval(async () => {
      const current = await fetch(`${API_URL}/api/jobs/${job.id}`).then((r) => r.json());
      setStatus(`Стадия: ${current.stage}`);
      if (current.status === 'completed') {
        window.clearInterval(poll);
        setOutputUrl(`${API_URL}/media/${current.output_path}`);
        setStatus('Черновик готов');
        void fetch(`${API_URL}/api/projects/${activeProjectId}`).then((response) => response.json()).then((detail) => {
          setSourceCredits((detail.assets ?? []).filter((asset: SourceCredit) => asset.source_provider && asset.source_url));
        });
      }
      if (current.status === 'failed') { window.clearInterval(poll); setRenderError(current.error_message ? `Рендер не удался: ${current.error_message}` : 'Рендер не удался. Откройте журнал worker на сервере.'); }
    }, 1500);
    void refreshProjects();
    } catch (error) { setRenderError(error instanceof Error ? error.message : 'Не удалось скачать кадры или запустить монтаж'); }
  }

  async function uploadToLibrary(event: FormEvent) {
    event.preventDefault();
    if (!libraryFile) return setStatus('Выбери файл для библиотеки');
    const data = new FormData();
    data.append('file', libraryFile);
    data.append('tags', libraryTags);
    const result = await fetch(`${API_URL}/api/library/assets`, { method: 'POST', body: data }).then((response) => response.json());
    setStatus(result.error ? result.error : 'Футаж добавлен в библиотеку');
    if (!result.error) { setLibraryFile(undefined); setLibraryTags(''); void searchLibrary(''); }
  }

  async function resumeProject(project: Project) {
    const detail = await fetch(`${API_URL}/api/projects/${project.id}`).then((response) => response.json());
    setActiveProjectId(project.id);
    setNewsText(detail.news_text);
    setSourceCredits((detail.assets ?? []).filter((asset: SourceCredit) => asset.source_provider && asset.source_url));
    const completed = detail.jobs?.find((job: { status: string }) => job.status === 'completed');
    setOutputUrl(completed?.output_path ? `${API_URL}/media/${completed.output_path}` : undefined);
    setStatus(`Открыт проект от ${new Date(project.created_at).toLocaleString('ru-RU')}`);
  }

  const filteredMedia=(remoteMedia??[]).filter(item=>item.kind===mediaTab && (!topicFilter||item.query===topicFilter));
  const totalPages=Math.max(1,Math.ceil(filteredMedia.length/12));
  const visibleMedia=filteredMedia.slice((displayPage-1)*12,displayPage*12);
  return <main>
    <header><span className="mark">НЛ</span><div><b>Автомонтаж новостей</b><small>локальная панель · серверный рендер</small></div></header>
    <section className="intro"><p>Создайте ролик из новости</p><span>{status}</span></section>
    {connectionError && <section className="error-panel" role="alert"><b>Не удалось связаться с сервером</b><p>{connectionError}</p><code>API: {API_URL}</code><button type="button" onClick={() => void checkConnection()}>Проверить связь</button></section>}
    {projects.length > 0 && <details className="projects"><summary>Сохранённые проекты</summary><div>{projects.map((project) => <button type="button" key={project.id} onClick={() => void resumeProject(project)}>{project.news_text.slice(0, 64)}…</button>)}</div></details>}
    <form onSubmit={startRender}>
      <div className="article-import"><input value={articleUrl} onChange={(e) => setArticleUrl(e.target.value)} placeholder="Ссылка на статью newpeople.ru/news/..." /><button type="button" onClick={() => void importArticle()}>Загрузить статью</button></div>
      <label htmlFor="news">Текст новости</label>
      <textarea id="news" value={newsText} onChange={(e) => setNewsText(e.target.value)} placeholder="Вставь текст новости. На сервере он станет раскадровкой и голосом." required />
      <section className="keyword-panel">
        <div className="section-title"><b>Темы для поиска</b><small>{analyzing?'Нейросеть анализирует текст…':keywordMode}</small></div>
        <p>Русская тема и английский запрос. Нажмите на текст, чтобы изменить его.</p>
        {keywordError && <div className="keyword-error" role="alert"><p>{keywordError}</p><button type="button" className="quiet" onClick={()=>setAnalysisAttempt(value=>value+1)}>Повторить анализ</button></div>}
        <div className="keyword-grid">{keywords.map((k,i)=><div className="keyword-chip" key={i}>
          <input aria-label={`Тема ${i+1}`} value={k.label} onChange={e=>setKeywords(old=>old.map((v,j)=>j===i?{...v,label:e.target.value}:v))}/>
          <input aria-label={`Запрос ${i+1}`} value={k.query} placeholder="English search query" onChange={e=>setKeywords(old=>old.map((v,j)=>j===i?{...v,query:e.target.value}:v))}/>
          <button type="button" aria-label={`Удалить тему ${i+1}`} onClick={()=>setKeywords(old=>old.filter((_,j)=>j!==i))}>×</button>
        </div>)}</div>
        <button type="button" className="quiet" disabled={analyzing||keywords.length>=12} onClick={()=>setKeywords(old=>[...old,{label:'Своя тема',query:''}])}>＋ Добавить тему</button>
      </section>
      <div className="upload"><b>Свои кадры — необязательно</b><span>{files.length ? `Выбрано: ${files.map((file) => file.name).join(', ')}` : 'Без них сервер найдёт подходящие стоковые видео и картинки сам. Ваши кадры имеют приоритет.'}</span><input key={assetInputKey} type="file" accept="video/*,image/*" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []))} /></div>
      <button className="primary" type="submit" disabled={searching||analyzing||!keywords.some(k=>k.query.trim())}>{searching ? 'Ищу кадры…' : 'Найти кадры'}</button>
    </form>
    <details className="library"><summary>Моя библиотека футажей</summary><p>Загрузи видео или картинку один раз, укажи теги — «Госдума, заседание, документы». Следующие новости смогут подобрать её сами.</p>
      <form onSubmit={uploadToLibrary} className="library-form"><input type="file" accept="video/*,image/*" onChange={(e) => setLibraryFile(e.target.files?.[0])} /><input value={libraryTags} onChange={(e) => setLibraryTags(e.target.value)} placeholder="Теги через запятую" /><button type="submit">Добавить в библиотеку</button></form>
      <div className="search"><input value={libraryQuery} onChange={(e) => setLibraryQuery(e.target.value)} placeholder="Найти футажи по словам" /><button type="button" onClick={() => void searchLibrary()}>Искать</button></div>
      <div className="asset-grid">{library.map((asset) => <label className="asset" key={asset.id}><input type="checkbox" checked={selectedLibraryIds.includes(asset.id)} onChange={() => setSelectedLibraryIds((ids) => ids.includes(asset.id) ? ids.filter((id) => id !== asset.id) : [...ids, asset.id])} />{asset.mime_type.startsWith('image/') ? <img src={`${API_URL}${asset.url}`} /> : <video muted src={`${API_URL}${asset.url}`} />}<span>{asset.original_name}</span><small>{asset.tags?.join(', ')}</small></label>)}</div>
    </details>
    {sourceCredits.length > 0 && <section className="credits"><b>Источники кадров</b>{sourceCredits.map((credit) => <a key={credit.source_url} href={credit.source_url} target="_blank" rel="noreferrer">{credit.source_provider}: {credit.source_author || 'автор'}{credit.source_license ? ` · ${credit.source_license}` : ''}</a>)}</section>}
    {remoteMedia && workflow==='select' && <div className="modal-backdrop"><section className="media-modal" role="dialog" aria-modal="true" aria-label="Подбор кадров">
      <header><div><b>Шаг 2 из 3 · Подбор кадров</b><small>Выберите до 8 материалов для ролика</small></div><button type="button" onClick={()=>{setRemoteMedia(undefined);setWorkflow('edit')}}>К тексту</button></header>
      <div className="media-toolbar"><div className="tabs">{(['video','photo'] as const).map(kind=><button type="button" key={kind} className={mediaTab===kind?'active':''} onClick={()=>{setMediaTab(kind);setDisplayPage(1);}}>{kind==='video'?'Видео':'Фото'} ({remoteMedia.filter(m=>m.kind===kind).length})</button>)}</div>
      <select aria-label="Фильтр по теме" value={topicFilter} onChange={e=>{setTopicFilter(e.target.value);setDisplayPage(1);}}><option value="">Все темы</option>{keywords.map((k,i)=><option key={i} value={k.query}>{k.label}</option>)}</select></div>
      {warnings.length>0&&<details className="search-warnings"><summary>Некоторые источники не ответили ({warnings.length})</summary>{warnings.map((w,i)=><p key={i}>{w}</p>)}</details>}
      {!filteredMedia.length&&<p className="empty">По этой теме {mediaTab==='video'?'видео':'фото'} пока нет. Измените русский или английский запрос либо добавьте свою тему.</p>}
      <div className="remote-grid">{visibleMedia.map(item=><article className={`asset media-card ${selectedRemoteIds.includes(item.id)?'selected':''}`} key={item.id}>
        <div className="media-preview">
          {item.kind==='photo'
            ? <img loading="lazy" src={item.previewUrl} alt={item.title}/>
            : <video controls muted preload="none" src={item.previewUrl.startsWith('/') ? `${API_URL}${item.previewUrl}` : item.previewUrl}/>
          }
        </div>
        <label className="pick"><input type="checkbox" aria-label={`Выбрать ${item.title}`} checked={selectedRemoteIds.includes(item.id)} onChange={()=>setSelectedRemoteIds(ids=>ids.includes(item.id)?ids.filter(id=>id!==item.id):ids.length<8?[...ids,item.id]:ids)}/> Выбрать</label>
        <span className="media-title" title={item.title}>{item.title}</span><small className="query-label">{item.query}</small>
        <a className="source-badge" href={item.sourceUrl} target="_blank" rel="noreferrer"><span aria-hidden="true">{sources[item.provider]?.icon??'↗'}</span>{sources[item.provider]?.name??item.provider} ↗</a>
      </article>)}</div>
      <div className="pagination"><button type="button" disabled={displayPage<=1} onClick={()=>setDisplayPage(p=>p-1)}>← Назад</button><span>{displayPage} / {totalPages}</span><button type="button" disabled={displayPage>=totalPages} onClick={()=>setDisplayPage(p=>p+1)}>Далее →</button>
      <button type="button" disabled={loadingMore||!hasMore} onClick={()=>void loadMore()}>{loadingMore?'Загружаю…':'Ещё из источников'}</button></div>
      <footer className="selection-bar"><span>Выбрано {selectedRemoteIds.length} / 8</span><button className="primary" type="button" onClick={()=>void startMontage()} disabled={!selectedRemoteIds.length}>Собрать ролик</button></footer>
    </section></div>}
    {workflow==='render' && <div className="modal-backdrop"><section className="render-screen" role="status"><p>Шаг 3 из 3</p><h2>{outputUrl ? 'Видео готово' : 'Собираю ролик'}</h2><div className="render-progress" aria-hidden="true"/><p>{status}</p>{renderError&&<p className="inline-error">{renderError}</p>}{outputUrl&&<><video controls autoPlay src={outputUrl}/><a className="primary export" href={outputUrl} download>Экспортировать MP4</a></>}<button type="button" className="quiet" onClick={()=>setWorkflow('edit')}>К новому ролику</button></section></div>}
    {outputUrl && <section className="output"><b>Готовый черновик</b><video controls src={outputUrl} /> <a href={outputUrl} download>Скачать MP4</a></section>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
