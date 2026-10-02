"""Bounded, offline DOCX text extraction. Never executes Word or external links."""
import io
import json
import sys
import zipfile
from xml.etree import ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
MAX_FILE = 10 * 1024 * 1024
MAX_XML = 20 * 1024 * 1024


def parse_docx(data):
    if not data or len(data) > MAX_FILE:
        raise ValueError('resume_file_size')
    if data.startswith(bytes.fromhex('d0cf11e0a1b11ae1')):
        raise ValueError('resume_encrypted')
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ValueError('resume_invalid_docx')
    with archive:
        infos = archive.infolist()
        names = [i.filename for i in infos]
        if len(infos) > 2000 or len(names) != len(set(names)) or sum(i.file_size for i in infos) > 80 * 1024 * 1024:
            raise ValueError('resume_archive_limit')
        if any(i.flag_bits & 1 for i in infos):
            raise ValueError('resume_encrypted')
        if 'word/document.xml' not in names or '[Content_Types].xml' not in names:
            raise ValueError('resume_invalid_docx')
        if any('vbaproject' in n.lower() for n in names):
            raise ValueError('resume_macro_unsupported')
        warnings, blocks = [], []
        image_count = sum(n.startswith('word/media/') and not n.endswith('/') for n in names)

        def xml(name):
            if archive.getinfo(name).file_size > MAX_XML:
                raise ValueError('resume_archive_limit')
            raw = archive.read(name)
            if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper() or b'\x00' in raw:
                raise ValueError('resume_invalid_docx')
            try:
                root = ET.fromstring(raw)
            except ET.ParseError:
                raise ValueError('resume_invalid_docx')
            pending = [(root, 0)]
            count = 0
            while pending:
                node, depth = pending.pop()
                count += 1
                if depth > 100 or count > 150000:
                    raise ValueError('resume_archive_limit')
                pending.extend((child, depth + 1) for child in node)
            return root

        def warn(value):
            if value not in warnings:
                warnings.append(value)

        def text(node):
            if node.tag in (W+'del', W+'moveFrom', W+'txbxContent'):
                return ''
            if node.tag == W+'t':
                return node.text or ''
            if node.tag == W+'tab':
                return '\t'
            if node.tag in (W+'br', W+'cr'):
                return '\n'
            if node.tag == W+'noBreakHyphen':
                return '\u2011'
            return ''.join(text(child) for child in node)

        def walk(root, source):
            for node in root:
                if node.tag in (W+'del', W+'moveFrom'):
                    continue
                if node.tag == W+'p':
                    value = text(node).strip()
                    if value:
                        style = node.find('./'+W+'pPr/'+W+'pStyle')
                        blocks.append({'type': 'paragraph', 'source': source, 'text': value,
                                       'style': style.get(W+'val', '') if style is not None else ''})
                    for box in node.iter(W+'txbxContent'):
                        walk(box, source + ':textbox')
                elif node.tag == W+'tbl':
                    rows = []
                    for row in node.findall('./'+W+'tr'):
                        cells = []
                        for cell in row.findall('./'+W+'tc'):
                            # Preserve paragraphs and nested-table text inside each cell.
                            def cell_paragraphs(parent):
                                for child in parent:
                                    if child.tag in (W+'del', W+'moveFrom'):
                                        continue
                                    if child.tag == W+'p':
                                        value = text(child).strip()
                                        if value:
                                            yield value
                                        for box in child.iter(W+'txbxContent'):
                                            yield from cell_paragraphs(box)
                                    else:
                                        yield from cell_paragraphs(child)
                            values = list(cell_paragraphs(cell))
                            cells.append('\n'.join(values))
                        if any(cells):
                            rows.append(cells)
                    if rows:
                        blocks.append({'type': 'table', 'source': source, 'rows': rows,
                                       'text': '\n'.join('\t'.join(row) for row in rows)})
                else:
                    walk(node, source)

        main = xml('word/document.xml')
        body = main.find(W+'body')
        if body is None:
            raise ValueError('resume_invalid_docx')
        parts = [('body', main, body)]
        # Referenced headers/footers only; never import abandoned parts or comments.
        referenced = set()
        for tag in ('headerReference', 'footerReference'):
            for node in main.iter(W+tag):
                referenced.add(node.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'))
        rels_path = 'word/_rels/document.xml.rels'
        if referenced and rels_path in names:
            for rel in xml(rels_path):
                if rel.get('Id') not in referenced or rel.get('TargetMode') == 'External':
                    continue
                target = rel.get('Target', '')
                name = 'word/' + target if not target.startswith('/') else target[1:]
                if name in names and name.startswith(('word/header', 'word/footer')) and '..' not in name:
                    root = xml(name)
                    parts.append((name.split('/')[-1].replace('.xml', ''), root, root))
        for name, tag in [('word/footnotes.xml','footnote'),('word/endnotes.xml','endnote')]:
            refs = {node.get(W+'id') for node in main.iter(W+tag+'Reference')}
            if refs and name in names:
                root = xml(name)
                for note in root:
                    if note.get(W+'id') in refs:
                        parts.append((tag+':'+note.get(W+'id'), note, note))
        for source, root, content in parts:
            if any(True for _ in root.iter(W+'numPr')):
                warn('文档包含自动编号：正文已提取，编号样式未复原，请对照原文件核对。')
            if any(True for tag in ('ins','del','moveFrom','moveTo') for _ in root.iter(W+tag)):
                warn('文档包含修订：按接受修订后的文字提取，删除内容与批注不计入正文。')
            if any(True for _ in root.iter(W+'txbxContent')):
                warn('文档包含文本框：文字已提取，位置可能与 Word 的视觉阅读顺序不同。')
            if any(True for tag in ('altChunk','sym','object') for _ in root.iter(W+tag)):
                warn('文档含嵌入内容或特殊符号，可能未完整提取，请对照原文件核对。')
            walk(content, source)
        if image_count:
            warn(f'原文件包含 {image_count} 个图片资源；本次不做 OCR，图片中的文字未提取。')
        if len(parts) > 1:
            warn('页眉、页脚与脚注文字单独保留在正文后；解析预览不复原分页和排版。')
        full_text = '\n\n'.join(block['text'] for block in blocks)
        if not full_text.strip():
            raise ValueError('resume_no_text')
        if len(full_text) > 500000 or len(blocks) > 10000:
            raise ValueError('resume_text_limit')
        for index, block in enumerate(blocks):
            block['id'] = 'B%04d' % (index + 1)
        return {'parser_version': 'docx-text-v1', 'text': full_text, 'blocks': blocks, 'warnings': warnings,
                'stats': {'characters': len(full_text), 'paragraphs': sum(b['type']=='paragraph' for b in blocks),
                          'tables': sum(b['type']=='table' for b in blocks), 'images': image_count}}


if __name__ == '__main__':
    try:
        data = sys.stdin.buffer.read(MAX_FILE + 1)
        print(json.dumps({'ok': True, 'document': parse_docx(data)}, ensure_ascii=False))
    except ValueError as exc:
        print(json.dumps({'ok': False, 'error': str(exc) if str(exc).startswith('resume_') else 'resume_invalid_docx'}))
    except Exception:
        print(json.dumps({'ok': False, 'error': 'resume_invalid_docx'}))
