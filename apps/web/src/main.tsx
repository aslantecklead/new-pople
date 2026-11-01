import { FormEvent, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8080';

type Project = { id: string; news_text: string; created_at: string };
type LibraryAsset = { id: string; original_name: string; mime_type: string; tags: string[]; url: string };
type SourceCredit = { source_provider: string; source_url: string; source_author?: string };

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

  async function refreshProjects() {
    const result = await fetch(`${API_URL}/api/projects`).then((response) => response.json());
    setProjects(result);
  }

  async function searchLibrary(query = libraryQuery) {
    const result = await fetch(`${API_URL}/api/library/search?q=${encodeURIComponent(query)}`).then((response) => response.json());
    setLibrary(result);
  }

  useEffect(() => {
    fetch(`${API_URL}/health`).then(async (response) => {
      const health = await response.json() as { stockSearch?: { pexels?: boolean; pixabay?: boolean } };
      const stockReady = health.stockSearch?.pexels || health.stockSearch?.pixabay;
      setStatus(response.ok ? (stockReady ? 'Сервер подключён · автопоиск стоков включён' : 'Сервер подключён · добавь PEXELS_API_KEY или PIXABAY_API_KEY для автопоиска') : 'Сервер недоступен');
      if (response.ok) { void refreshProjects(); void searchLibrary(''); }
    }).catch(() => setStatus('Сервер недоступен'));
  }, []);

  async function startRender(event: FormEvent) {
    event.preventDefault();
    setStatus('Создаю проект…');
    const project = activeProjectId
      ? await fetch(`${API_URL}/api/projects/${activeProjectId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newsText }) }).then((r) => r.json())
      : await fetch(`${API_URL}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newsText }) }).then((r) => r.json());
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
    const job = await fetch(`${API_URL}/api/projects/${project.id}/render`, { method: 'POST' }).then((r) => r.json());
    if (job.error) return setStatus(job.error);
    setStatus('Ролик собирается: раскадровка…');
    const poll = window.setInterval(async () => {
      const current = await fetch(`${API_URL}/api/jobs/${job.id}`).then((r) => r.json());
      setStatus(`Стадия: ${current.stage}`);
      if (current.status === 'completed') {
        window.clearInterval(poll);
        setOutputUrl(`${API_URL}/media/${current.output_path}`);
        setStatus('Черновик готов');
        void fetch(`${API_URL}/api/projects/${project.id}`).then((response) => response.json()).then((detail) => {
          setSourceCredits((detail.assets ?? []).filter((asset: SourceCredit) => asset.source_provider && asset.source_url));
        });
      }
      if (current.status === 'failed') { window.clearInterval(poll); setStatus('Рендер не удался — проверь логи worker'); }
    }, 1500);
    void refreshProjects();
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
    {projects.length > 0 && <section className="projects"><b>Сохранённые проекты</b><div>{projects.map((project) => <button type="button" key={project.id} onClick={() => void resumeProject(project)}>{project.news_text.slice(0, 64)}…</button>)}</div></section>}
    <form onSubmit={startRender}>
      <label htmlFor="news">Текст новости</label>
      <textarea id="news" value={newsText} onChange={(e) => setNewsText(e.target.value)} placeholder="Вставь текст новости. На сервере он станет раскадровкой и голосом." required />
      <div className="upload"><b>Свои кадры — необязательно</b><span>{files.length ? `Выбрано: ${files.map((file) => file.name).join(', ')}` : 'Без них сервер найдёт подходящие стоковые видео и картинки сам. Ваши кадры имеют приоритет.'}</span><input key={assetInputKey} type="file" accept="video/*,image/*" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []))} /></div>
      <button className="primary" type="submit">Найти кадры и собрать черновик</button>
    </form>
    <section className="library"><h2>Библиотека футажей</h2><p>Загрузи видео или картинку один раз, укажи теги — «Госдума, заседание, документы». Следующие новости смогут подобрать её сами.</p>
      <form onSubmit={uploadToLibrary} className="library-form"><input type="file" accept="video/*,image/*" onChange={(e) => setLibraryFile(e.target.files?.[0])} /><input value={libraryTags} onChange={(e) => setLibraryTags(e.target.value)} placeholder="Теги через запятую" /><button type="submit">Добавить в библиотеку</button></form>
      <div className="search"><input value={libraryQuery} onChange={(e) => setLibraryQuery(e.target.value)} placeholder="Найти футажи по словам" /><button type="button" onClick={() => void searchLibrary()}>Искать</button></div>
      <div className="asset-grid">{library.map((asset) => <label className="asset" key={asset.id}><input type="checkbox" checked={selectedLibraryIds.includes(asset.id)} onChange={() => setSelectedLibraryIds((ids) => ids.includes(asset.id) ? ids.filter((id) => id !== asset.id) : [...ids, asset.id])} />{asset.mime_type.startsWith('image/') ? <img src={`${API_URL}${asset.url}`} /> : <video muted src={`${API_URL}${asset.url}`} />}<span>{asset.original_name}</span><small>{asset.tags?.join(', ')}</small></label>)}</div>
    </section>
    {sourceCredits.length > 0 && <section className="credits"><b>Источники кадров</b>{sourceCredits.map((credit) => <a key={credit.source_url} href={credit.source_url} target="_blank" rel="noreferrer">{credit.source_provider}: {credit.source_author || 'автор'}</a>)}</section>}
    {outputUrl && <section className="output"><b>Готовый черновик</b><video controls src={outputUrl} /> <a href={outputUrl} download>Скачать MP4</a></section>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
