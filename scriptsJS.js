const fileInput = document.querySelector('#file-input');
const addButton = document.querySelector('#add-button');
const mergeButton = document.querySelector('#merge-button');
const dropZone = document.querySelector('#drop-zone');
const chapterList = document.querySelector('#chapter-list');
const emptyState = document.querySelector('#empty-state');
const chapterCount = document.querySelector('#chapter-count');
const outputName = document.querySelector('#output-name');
const status = document.querySelector('#status');
let chapters = [];

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);

function readUint16(view, offset) { return view.getUint16(offset, true); }
function readUint32(view, offset) { return view.getUint32(offset, true); }

function naturalKey(value) {
	return value.toLowerCase().split(/(\d+)/).map(part => /^\d+$/.test(part) ? Number(part) : part);
}

function compareNatural(left, right) {
	const a = naturalKey(left);
	const b = naturalKey(right);
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		if (a[index] === b[index]) continue;
		if (a[index] === undefined) return -1;
		if (b[index] === undefined) return 1;
		return a[index] < b[index] ? -1 : 1;
	}
	return 0;
}

async function unzipImages(file) {
	const buffer = await file.arrayBuffer();
	const view = new DataView(buffer);
	const bytes = new Uint8Array(buffer);
	let end = bytes.length - 22;
	while (end >= 0 && readUint32(view, end) !== 0x06054b50) end -= 1;
	if (end < 0) throw new Error(`${file.name} n’est pas une archive ZIP valide.`);
	const count = readUint16(view, end + 10);
	const centralOffset = readUint32(view, end + 16);
	const entries = [];
	let cursor = centralOffset;
	for (let index = 0; index < count; index += 1) {
		if (readUint32(view, cursor) !== 0x02014b50) throw new Error(`Archive CBZ invalide : ${file.name}.`);
		const method = readUint16(view, cursor + 10);
		const compressedSize = readUint32(view, cursor + 20);
		const nameLength = readUint16(view, cursor + 28);
		const extraLength = readUint16(view, cursor + 30);
		const commentLength = readUint16(view, cursor + 32);
		const localOffset = readUint32(view, cursor + 42);
		const name = new TextDecoder().decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
		cursor += 46 + nameLength + extraLength + commentLength;
		if (name.endsWith('/') || !IMAGE_EXTENSIONS.has(name.slice(name.lastIndexOf('.')).toLowerCase())) continue;
		const localNameLength = readUint16(view, localOffset + 26);
		const localExtraLength = readUint16(view, localOffset + 28);
		const start = localOffset + 30 + localNameLength + localExtraLength;
		let data = bytes.slice(start, start + compressedSize);
		if (method === 8) data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
		if (method !== 0 && method !== 8) throw new Error(`Compression non prise en charge dans ${file.name}.`);
		entries.push({ name, data });
	}
	return entries.sort((left, right) => compareNatural(left.name, right.name));
}

function crc32(data) {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries) {
	const encoder = new TextEncoder();
	const localParts = [];
	const centralParts = [];
	let offset = 0;
	entries.forEach(entry => {
		const name = encoder.encode(entry.name);
		const header = new ArrayBuffer(30 + name.length);
		const view = new DataView(header);
		view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true);
		view.setUint16(8, 0, true); view.setUint16(10, 0, true);
		view.setUint32(14, crc32(entry.data), true); view.setUint32(18, entry.data.length, true); view.setUint32(22, entry.data.length, true);
		view.setUint16(26, name.length, true); new Uint8Array(header).set(name, 30);
		localParts.push(header, entry.data);
		const central = new ArrayBuffer(46 + name.length);
		const centralView = new DataView(central);
		centralView.setUint32(0, 0x02014b50, true); centralView.setUint16(4, 20, true); centralView.setUint16(6, 20, true);
		centralView.setUint32(16, crc32(entry.data), true); centralView.setUint32(20, entry.data.length, true); centralView.setUint32(24, entry.data.length, true);
		centralView.setUint16(28, name.length, true); centralView.setUint32(42, offset, true); new Uint8Array(central).set(name, 46);
		centralParts.push(central); offset += header.byteLength + entry.data.length;
	});
	const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
	const end = new ArrayBuffer(22); const endView = new DataView(end);
	endView.setUint32(0, 0x06054b50, true); endView.setUint16(8, entries.length, true); endView.setUint16(10, entries.length, true);
	endView.setUint32(12, centralSize, true); endView.setUint32(16, offset, true);
	return new Blob([...localParts, ...centralParts, end], { type: 'application/vnd.comicbook+zip' });
}

const sizeLabel = (bytes) => {
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
	return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
};

function setStatus(message, kind = '') {
	status.textContent = message;
	status.className = `status ${kind}`;
}

function render() {
	chapterList.innerHTML = '';
	chapters.forEach((file, index) => {
		const row = document.createElement('li');
		row.className = 'chapter-row';
		row.draggable = true;
		row.dataset.index = index;
		row.innerHTML = `<span class="chapter-order">${String(index + 1).padStart(2, '0')}</span>
			<div class="chapter-info"><span class="grip" aria-hidden="true">⋮⋮</span>
			<span class="chapter-name" title="${file.name}">${file.name}</span><span class="chapter-size">${sizeLabel(file.size)}</span></div>
			<button class="remove-button" type="button" aria-label="Retirer ${file.name}">×</button>`;
		row.querySelector('.remove-button').addEventListener('click', () => {
			chapters.splice(index, 1);
			render();
		});
		row.addEventListener('dragstart', () => row.classList.add('is-dragging'));
		row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
		row.addEventListener('dragover', (event) => {
			event.preventDefault();
			const dragging = chapterList.querySelector('.is-dragging');
			if (!dragging || dragging === row) return;
			const rect = row.getBoundingClientRect();
			row.parentNode.insertBefore(dragging, event.clientY < rect.top + rect.height / 2 ? row : row.nextSibling);
		});
		row.addEventListener('drop', () => {
			chapters = [...chapterList.querySelectorAll('.chapter-row')].map(item => chapters[Number(item.dataset.index)]);
			render();
		});
		chapterList.append(row);
	});
	const hasItems = chapters.length > 0;
	chapterList.classList.toggle('has-items', hasItems);
	emptyState.hidden = hasItems;
	chapterCount.textContent = hasItems ? `${chapters.length} chapitre${chapters.length > 1 ? 's' : ''}` : 'Aucun chapitre sélectionné';
	mergeButton.disabled = !hasItems;
}

function addFiles(fileList) {
	const incoming = [...fileList].filter(file => file.name.toLowerCase().endsWith('.cbz'));
	const known = new Set(chapters.map(file => `${file.name}-${file.size}-${file.lastModified}`));
	chapters.push(...incoming.filter(file => !known.has(`${file.name}-${file.size}-${file.lastModified}`)));
	render();
	if (incoming.length !== fileList.length) setStatus('Seuls les fichiers .cbz ont été ajoutés.', 'error');
}

addButton.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') fileInput.click(); });
['dragenter', 'dragover'].forEach(type => dropZone.addEventListener(type, event => { event.preventDefault(); dropZone.classList.add('is-over'); }));
['dragleave', 'drop'].forEach(type => dropZone.addEventListener(type, event => { event.preventDefault(); dropZone.classList.remove('is-over'); }));
dropZone.addEventListener('drop', event => addFiles(event.dataTransfer.files));

mergeButton.addEventListener('click', async () => {
	mergeButton.disabled = true;
	setStatus('Fusion en cours…');
	try {
		const pages = [];
		for (const chapter of chapters) pages.push(...await unzipImages(chapter));
		const blob = createZip(pages.map((page, index) => ({ ...page, name: `${String(index + 1).padStart(5, '0')}${page.name.slice(page.name.lastIndexOf('.')).toLowerCase()}` })));
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = `${outputName.value.trim() || 'tome'}.cbz`;
		link.click();
		URL.revokeObjectURL(url);
		setStatus('Le tome a été créé et téléchargé.', 'success');
	} catch (error) {
		setStatus(`Impossible de fusionner : ${error.message}`, 'error');
	} finally {
		mergeButton.disabled = chapters.length === 0;
	}
});

render();
