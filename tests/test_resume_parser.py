import importlib.util
import io
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('resume_parser', Path(__file__).resolve().parents[1] / 'local/parse-resume.py')
parser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parser)
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'


def docx(body, extra=None):
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', '<Types/>')
        z.writestr('word/document.xml', f'<w:document xmlns:w="{W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>{body}</w:body></w:document>')
        for name, value in (extra or {}).items():
            z.writestr(name, value)
    return data.getvalue()


class ParserTests(unittest.TestCase):
    def test_preserves_runs_tables_hyperlinks_and_order(self):
        data = docx('<w:p><w:r><w:t>项目背景：</w:t></w:r><w:r><w:t>不是概括摘要。</w:t></w:r><w:hyperlink><w:r><w:t>原文链接</w:t></w:r></w:hyperlink></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>项目 A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>投保</w:t><w:br/><w:t>理赔</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>最终成果 25%。</w:t></w:r></w:p>')
        out = parser.parse_docx(data)
        self.assertEqual(out['text'], '项目背景：不是概括摘要。原文链接\n\n项目 A\t投保\n理赔\n\n最终成果 25%。')
        self.assertEqual([b['type'] for b in out['blocks']], ['paragraph','table','paragraph'])
        self.assertEqual(out['stats']['tables'], 1)

    def test_textboxes_revisions_numbering_images_warn_without_summary(self):
        data = docx('<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>参与</w:t></w:r><w:del><w:r><w:delText>主导</w:delText></w:r></w:del><w:ins><w:r><w:t>项目交付</w:t></w:r></w:ins><w:r><w:pict><w:txbxContent><w:p><w:r><w:t>文本框经历</w:t></w:r></w:p></w:txbxContent></w:pict></w:r></w:p>', {'word/media/test.png': b'png'})
        out = parser.parse_docx(data)
        self.assertEqual(out['text'],'参与项目交付\n\n文本框经历')
        self.assertEqual(out['text'].count('文本框经历'),1)
        self.assertEqual(len(out['warnings']),4)

    def test_only_referenced_header_footer_and_notes(self):
        data = docx('<w:p><w:r><w:t>正文</w:t><w:footnoteReference w:id="1"/></w:r></w:p><w:sectPr><w:headerReference r:id="rH"/></w:sectPr>', {
            'word/_rels/document.xml.rels':'<Relationships><Relationship Id="rH" Target="header1.xml"/><Relationship Id="ext" Target="https://example.invalid" TargetMode="External"/></Relationships>',
            'word/header1.xml':f'<w:hdr xmlns:w="{W}"><w:p><w:r><w:t>真实页眉</w:t></w:r></w:p></w:hdr>',
            'word/header2.xml':f'<w:hdr xmlns:w="{W}"><w:p><w:r><w:t>弃用页眉</w:t></w:r></w:p></w:hdr>',
            'word/footnotes.xml':f'<w:footnotes xmlns:w="{W}"><w:footnote w:id="1"><w:p><w:r><w:t>注释原文</w:t></w:r></w:p></w:footnote></w:footnotes>'})
        out=parser.parse_docx(data)
        self.assertEqual(out['text'],'正文\n\n真实页眉\n\n注释原文')

    def test_reject_invalid_empty_macro_and_xml_entities(self):
        for data, error in [(b'not a zip','resume_invalid_docx'),(docx(''),'resume_no_text'),(docx('<w:p/>',{'word/vbaProject.bin':b'x'}),'resume_macro_unsupported')]:
            with self.assertRaisesRegex(ValueError,error):
                parser.parse_docx(data)
        with self.assertRaisesRegex(ValueError,'resume_invalid_docx'):
            parser.parse_docx(docx('<!DOCTYPE foo><w:p/>'))

    def test_deleted_paragraph_in_table_excluded(self):
        out=parser.parse_docx(docx('<w:tbl><w:tr><w:tc><w:del><w:p><w:r><w:t>删除内容</w:t></w:r></w:p></w:del><w:p><w:r><w:t>当前内容</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'))
        self.assertEqual(out['text'],'当前内容')


if __name__ == '__main__':
    unittest.main()
