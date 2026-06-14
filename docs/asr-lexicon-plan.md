# ASR 自定义纠错词库 - 实现方案

## 目标
用户可添加「ASR 常错词 → 正确词」映射。纠错时，词库中的词强制替换，解决"牛展→牛腱"这类 AI 也分不出的同音词。

## 后端（已完成，无需改动）
- `GET /api/asr/lexicon` — 返回用户词库 `[{term: "牛展=牛腱"}, ...]`  
- `PUT /api/asr/lexicon` — 保存词库 `{terms: ["牛展=牛腱", "六一=六一"]}`  
- `buildAsrCorrectionContext` 已自动读取词库传给 DeepSeek

## 前端需要做的

### 1. 在用户菜单里加一个入口
在头像下拉菜单中（`showUserMenu` 区域），加一行：
```
📖 ASR 纠错词库
```
点击打开词库编辑弹窗。

### 2. 词库编辑弹窗
一个 Modal 弹窗，包含：
- **添加输入框**：一个 input + 添加按钮，格式 `错误词=正确词`（如 `牛展=牛腱`）
- **词条列表**：每行显示一个映射 + 删除按钮
- **保存按钮**：调 `PUT /api/asr/lexicon` 保存
- **加载**：弹窗打开时调 `GET /api/asr/lexicon` 加载现有词库

### 3. 关键逻辑
```tsx
// 状态
const [asrLexicon, setAsrLexicon] = useState<string[]>([])
const [newLexiconTerm, setNewLexiconTerm] = useState('')

// 加载
const loadLexicon = async () => {
  const r = await axios.get(`${API}/asr/lexicon`, { headers: getAuthHeaders() })
  setAsrLexicon(r.data.data?.terms || [])
}

// 保存
const saveLexicon = async () => {
  await axios.put(`${API}/asr/lexicon`, { terms: asrLexicon }, { headers: getAuthHeaders() })
}
```

### 4. i18n
需要加这些 key（四语言）：
- `asrLexicon`: "纠错词库" / "ASR Lexicon" / "ASR辞書" / "ASR 어휘"
- `addLexiconHint`: "格式：错误词=正确词" / "Format: wrong=correct"
- `saveLexicon`: "保存词库"

## 注意
- 词库保存的是 `错误词=正确词` 的字符串数组，不是 JSON 对象
- `buildAsrCorrectionContext` 已自动解析这种格式
- 弹窗用小 Modal 就行，不要做太复杂
