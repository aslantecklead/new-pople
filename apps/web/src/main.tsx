import { FormEvent, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

// Vite proxies these paths through the local SSH tunnel in development, so the
// browser always talks to the same origin as the panel.
const API_URL = import.meta.env.VITE_API_URL ?? '';

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
    const searchResponse = await fetch(`${API_URL}/api/media/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newsText }), signal: AbortSignal.timeout(45_000) });
    const search = await searchResponse.json();
    if (!searchResponse.ok) return setStatus(search.error ?? `Поиск не запустился (HTTP ${searchResponse.status})`);
    if (search.error) return setStatus(search.error);
    setRemoteMedia(search.items ?? []);
    setSelectedRemoteIds((search.items ?? []).slice(0, 5).map((item: RemoteMedia) => item.id));
    setStatus(search.items?.length ? 'Материалы найдены — выбери кадры для монтажа' : 'Ничего не найдено: измени текст или добавь свои кадры');
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
    setStatus('Скачиваю выбранные кадры на сервер…');
    const imported = await fetch(`${API_URL}/api/projects/${activeProjectId}/assets/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mediaIds: selectedRemoteIds }), signal: AbortSignal.timeout(120_000) }).then((r) => r.json());
    if (imported.error) return setStatus(imported.error);
    setRemoteMedia(undefined);
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
      if (current.status === 'failed') { window.clearInterval(poll); setStatus('Рендер не удался — проверь логи worker'); }
    }, 1500);
    void refreshProjects();
    } catch { setStatus('Не удалось скачать кадры или запустить монтаж'); }
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

  return <main>
    <header><span className="mark">НЛ</span><div><b>Автомонтаж новостей</b><small>локальная панель · серверный рендер</small></div></header>
    <section className="intro"><p>Текст → сцены и поиск стоков → кадры → голос → субтитры → MP4.</p><span>{status}</span></section>
    {connectionError && <section className="error-panel" role="alert"><b>Не удалось связаться с сервером</b><p>{connectionError}</p><code>API: {API_URL}</code><button type="button" onClick={() => void checkConnection()}>Проверить связь</button></section>}
    {projects.length > 0 && <section className="projects"><b>Сохранённые проекты</b><div>{projects.map((project) => <button type="button" key={project.id} onClick={() => void resumeProject(project)}>{project.news_text.slice(0, 64)}…</button>)}</div></section>}
    <form onSubmit={startRender}>
      <div className="article-import"><input value={articleUrl} onChange={(e) => setArticleUrl(e.target.value)} placeholder="Ссылка на статью newpeople.ru/news/..." /><button type="button" onClick={() => void importArticle()}>Загрузить статью</button></div>
      <label htmlFor="news">Текст новости</label>
      <textarea id="news" value={newsText} onChange={(e) => setNewsText(e.target.value)} placeholder="Вставь текст новости. На сервере он станет раскадровкой и голосом." required />
      <div className="upload"><b>Свои кадры — необязательно</b><span>{files.length ? `Выбрано: ${files.map((file) => file.name).join(', ')}` : 'Без них сервер найдёт подходящие стоковые видео и картинки сам. Ваши кадры имеют приоритет.'}</span><input key={assetInputKey} type="file" accept="video/*,image/*" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []))} /></div>
      <button className="primary" type="submit" disabled={searching}>{searching ? 'Ищу кадры…' : 'Найти кадры'}</button>
    </form>
    <section className="library"><h2>Библиотека футажей</h2><p>Загрузи видео или картинку один раз, укажи теги — «Госдума, заседание, документы». Следующие новости смогут подобрать её сами.</p>
      <form onSubmit={uploadToLibrary} className="library-form"><input type="file" accept="video/*,image/*" onChange={(e) => setLibraryFile(e.target.files?.[0])} /><input value={libraryTags} onChange={(e) => setLibraryTags(e.target.value)} placeholder="Теги через запятую" /><button type="submit">Добавить в библиотеку</button></form>
      <div className="search"><input value={libraryQuery} onChange={(e) => setLibraryQuery(e.target.value)} placeholder="Найти футажи по словам" /><button type="button" onClick={() => void searchLibrary()}>Искать</button></div>
      <div className="asset-grid">{library.map((asset) => <label className="asset" key={asset.id}><input type="checkbox" checked={selectedLibraryIds.includes(asset.id)} onChange={() => setSelectedLibraryIds((ids) => ids.includes(asset.id) ? ids.filter((id) => id !== asset.id) : [...ids, asset.id])} />{asset.mime_type.startsWith('image/') ? <img src={`${API_URL}${asset.url}`} /> : <video muted src={`${API_URL}${asset.url}`} />}<span>{asset.original_name}</span><small>{asset.tags?.join(', ')}</small></label>)}</div>
    </section>
    {sourceCredits.length > 0 && <section className="credits"><b>Источники кадров</b>{sourceCredits.map((credit) => <a key={credit.source_url} href={credit.source_url} target="_blank" rel="noreferrer">{credit.source_provider}: {credit.source_author || 'автор'}{credit.source_license ? ` · ${credit.source_license}` : ''}</a>)}</section>}
    {remoteMedia && <div className="modal-backdrop"><section className="media-modal"><header><b>Подбор кадров</b><button type="button" onClick={() => setRemoteMedia(undefined)}>Закрыть</button></header><p>Открытые источники · выбери до восьми материалов, затем сервис скачает их и соберёт ролик.</p><div className="tabs"><button type="button" className={mediaTab === 'video' ? 'active' : ''} onClick={() => setMediaTab('video')}>Видео ({remoteMedia.filter((item) => item.kind === 'video').length})</button><button type="button" className={mediaTab === 'photo' ? 'active' : ''} onClick={() => setMediaTab('photo')}>Фото ({remoteMedia.filter((item) => item.kind === 'photo').length})</button></div><div className="remote-grid">{remoteMedia.filter((item) => item.kind === mediaTab).map((item) => <label className="asset" key={item.id}><input type="checkbox" checked={selectedRemoteIds.includes(item.id)} onChange={() => setSelectedRemoteIds((ids) => ids.includes(item.id) ? ids.filter((id) => id !== item.id) : ids.length < 8 ? [...ids, item.id] : ids)} />{item.kind === 'photo' ? <img src={item.previewUrl} /> : <video muted controls preload="metadata" src={item.previewUrl} />}<span>{item.title}</span><small>{item.provider} · {item.query}</small><a href={item.sourceUrl} target="_blank" rel="noreferrer">Источник</a></label>)}</div><button className="primary" type="button" onClick={() => void startMontage()} disabled={!selectedRemoteIds.length}>Скачать выбранное и собрать ролик</button></section></div>}
    {outputUrl && <section className="output"><b>Готовый черновик</b><video controls src={outputUrl} /> <a href={outputUrl} download>Скачать MP4</a></section>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
