# 第三方来源与许可

## boss-zhipin-scraper

- 来源：https://github.com/eatmoreduck/boss-zhipin-scraper
- 版本：2.3.0；固定提交：`46e2965de42c6c44a18021c1f8602a62b838297c`。
- 作者：eatmoreduck；许可：MIT。
- 随仓库分发未修改的 `scripts/boss_cdp_raw.py`、`data/city_codes.json`、原始依赖说明与 [LICENSE](vendor/boss-zhipin-scraper/LICENSE)。文件校验值见 [SOURCE.json](vendor/boss-zhipin-scraper/SOURCE.json)。未捆绑上游自动工作流、安装器或浏览器数据。
- 本地桥接直接加载上述模块的 CDP、搜索与页面解析能力；集成和规则适配在本项目 `local/`、`shared/` 中维护。早期共享 DOM 选择器参考同项目提交 `6b8221150c6ffc41814cb41bd773116ff34173e1`。
- `Ocyss/boss-helper` 是早期调研对象，本版本不包含其代码或运行依赖。

## 运行依赖与工具

Python 依赖由安装脚本从包索引安装，不将虚拟环境或第三方二进制提交到仓库。固定版本见 `requirements.txt`；相应软件继续遵循各自许可证。Node.js、Python、Microsoft Edge、Windows/.NET 和 Codex CLI 由用户单独安装，本项目 MIT 许可不替代这些工具的许可或服务条款。

平台页面、JD、企业资料和使用者简历不属于本项目授权再分发的素材。示例测试为合成输入，运行所得数据默认只留在本机。
