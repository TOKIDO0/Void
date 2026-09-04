//! AQ spike：Windows 原生 OCR（Windows.Media.Ocr，系统自带、免费、离线）。
//! 截图复用现有 desktop.screenshot 管线；本模块只做"图片文件 → 文本行"。
//! spike 结论见冒烟输出；若保留为 AQ 地基，需补 TIFF/语言回退与正式单测。

use windows::{
    core::HSTRING,
    Globalization::Language,
    Graphics::Imaging::BitmapDecoder,
    Media::Ocr::OcrEngine,
    Storage::{FileAccessMode, StorageFile},
};

/// 按 zh-Hans-CN → zh-Hans → 用户画像语言顺序建引擎，返回实际命中的语言标签。
fn create_engine() -> Result<(OcrEngine, String), String> {
    for tag in ["zh-Hans-CN", "zh-Hans"] {
        let language = Language::CreateLanguage(&HSTRING::from(tag))
            .map_err(|error| format!("构造语言标签失败（{tag}）：{error}"))?;
        let supported = OcrEngine::IsLanguageSupported(&language).unwrap_or(false);
        if supported {
            let engine = OcrEngine::TryCreateFromLanguage(&language)
                .map_err(|error| format!("创建 OCR 引擎失败（{tag}）：{error}"))?;
            return Ok((engine, tag.to_string()));
        }
    }
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|error| format!("创建 OCR 引擎失败（画像语言）：{error}"))?;
    Ok((engine, "user-profile".to_string()))
}

/// 识别 PNG/JPG 图片文件，返回行文本（spike 兼容口，坐标版见下）。
#[allow(dead_code)]
pub fn recognize_image_file(path: &str) -> Result<Vec<String>, String> {
    recognize_with_boxes(path).map(|lines| {
        let mut texts = Vec::with_capacity(lines.len());
        for line in lines {
            texts.push(line.text);
        }
        texts
    })
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrWordView {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrLineView {
    pub text: String,
    pub words: Vec<OcrWordView>,
}

const MAX_OCR_LINES: usize = 200;
const MAX_OCR_WORDS_PER_LINE: usize = 100;

/// AQ：行 + 词级坐标（屏幕像素系，可直接喂给接管点击）。
pub fn recognize_with_boxes(path: &str) -> Result<Vec<OcrLineView>, String> {
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))
        .map_err(|error| format!("打开图片失败：{error}"))?
        .get()
        .map_err(|error| format!("等待文件句柄失败：{error}"))?;
    let stream = file
        .OpenAsync(FileAccessMode::Read)
        .map_err(|error| format!("打开读流失败：{error}"))?
        .get()
        .map_err(|error| format!("等待读流失败：{error}"))?;
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|error| format!("解码图片失败：{error}"))?
        .get()
        .map_err(|error| format!("等待解码失败：{error}"))?;
    let frame = decoder
        .GetFrameAsync(0)
        .map_err(|error| format!("取首帧失败：{error}"))?
        .get()
        .map_err(|error| format!("等待首帧失败：{error}"))?;
    let bitmap = frame
        .GetSoftwareBitmapAsync()
        .map_err(|error| format!("转位图失败：{error}"))?
        .get()
        .map_err(|error| format!("等待位图失败：{error}"))?;
    let (engine, _) = create_engine()?;
    let operation = engine
        .RecognizeAsync(&bitmap)
        .map_err(|error| format!("启动识别失败：{error}"))?;
    let outcome = operation
        .get()
        .map_err(|error| format!("等待识别失败：{error}"))?;
    let lines = outcome
        .Lines()
        .map_err(|error| format!("取文本行失败：{error}"))?;
    let mut out = Vec::new();
    for line in lines.into_iter().take(MAX_OCR_LINES) {
        let text = line
            .Text()
            .map_err(|error| format!("取行文本失败：{error}"))?
            .to_string();
        if text.trim().is_empty() {
            continue;
        }
        let mut words = Vec::new();
        if let Ok(native_words) = line.Words() {
            for word in native_words.into_iter().take(MAX_OCR_WORDS_PER_LINE) {
                let word_text = word.Text().map(|value| value.to_string()).unwrap_or_default();
                if word_text.trim().is_empty() {
                    continue;
                }
                let (x, y, width, height) = word
                    .BoundingRect()
                    .map(|rect| (rect.X as f64, rect.Y as f64, rect.Width as f64, rect.Height as f64))
                    .unwrap_or((0.0, 0.0, 0.0, 0.0));
                words.push(OcrWordView {
                    text: word_text,
                    x,
                    y,
                    width,
                    height,
                });
            }
        }
        out.push(OcrLineView { text, words });
    }
    Ok(out)
}

/// AQ：Tauri 命令。路径白名单：仅运行时根内（防任意文件读取）。
#[tauri::command]
pub fn ocr_image_file(path: String) -> Result<Vec<OcrLineView>, String> {
    let root = std::env::var("VOID_RUNTIME_ROOT").unwrap_or_else(|_| "D:\\AI\\void-runtime".to_string());
    let normalized = path.replace('/', "\\").to_lowercase();
    let prefix = root.replace('/', "\\").trim_end_matches('\\').to_lowercase() + "\\";
    if normalized != prefix.trim_end_matches('\\') && !normalized.starts_with(&prefix) {
        return Err("只允许识别运行时目录内的图片".to_string());
    }
    recognize_with_boxes(&path)
}

#[cfg(test)]
mod spike_tests {
    use super::*;

    /// spike：VOID_OCR_SPIKE_PNG 指向对照图；未设变量时跳过（不污染常规 cargo test）。
    /// 对照图用 PS 现场生成（见交接），断言拉丁必过；中文逐字正确即算过（空格系分词伪影）。
    /// 另断言词级坐标非空（AQ 接管点击依赖）。
    #[test]
    fn ocr_spike_reads_fixture() {
        let Ok(path) = std::env::var("VOID_OCR_SPIKE_PNG") else {
            println!("OCR_SPIKE_SKIPPED");
            return;
        };
        let lines = recognize_image_file(&path).expect("OCR 执行失败");
        let joined = lines.join("\n");
        println!("OCR_LINES:\n{joined}");
        assert!(joined.contains("VOID"), "缺 VOID：{joined}");
        assert!(joined.contains("123"), "缺 123：{joined}");
        let boxed = recognize_with_boxes(&path).expect("OCR 词级执行失败");
        assert!(
            boxed.iter().any(|line| !line.words.is_empty()),
            "词级坐标为空：{joined}"
        );
        if joined.contains("中文") {
            println!("OCR_CHINESE: yes");
        } else {
            println!("OCR_CHINESE: no");
        }
    }
}
