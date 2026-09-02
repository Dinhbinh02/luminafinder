# 📂 Fetchy

![Fetchy Banner](banner.png)

**Fetchy** is a lightweight, high-performance Chrome Extension designed to streamline your Google Drive, Google Docs, and online course learning experience. It provides a minimalist, unified interface for scanning folders, downloading files, and extracting lecture audio with parallel processing and export format selection.

---

## ✨ Features

- **🚀 Parallel Scanning:** High-speed recursive folder scanning using optimized parallel requests.
- **🎓 Course & Lesson Downloader:** Auto-detects online LMS courses (e.g. khokhoahoc.org) and batch-downloads audio tracks with 100% original pitch and clarity.
- **📄 Document Export:** One-click export for Google Docs, Sheets, and Slides into multiple formats (PDF, DOCX, XLSX, etc.).
- **🎬 Media & Audio Discovery:** Automatically identifies video streams and extracts audio tracks directly into high-fidelity MP3.
- **🎨 Minimalist UI:** A sleek, glassmorphism-inspired design with dynamic state animations.
- **🔒 Privacy First:** Local metadata extraction—your cookies and data never leave your browser.
- **🔄 Intelligent Refresh:** Auto-updates expired download links and tokens on-the-fly.

---

## 🛠️ Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/[YOUR_USERNAME]/fetchy.git
    ```
2.  **Open Chrome Extensions:**
    Navigate to `chrome://extensions/` in your browser.
3.  **Enable Developer Mode:**
    Toggle the switch in the top right corner.
4.  **Load Unpacked:**
    Click **"Load unpacked"** and select the `fetchy` directory.

---

## 📖 Usage

1.  Open any Google Drive folder, document, or course page.
2.  Click the **Fetchy** icon in your toolbar.
3.  Choose your desired files, lessons, or export formats.
4.  Hit **Download** and let Fetchy do the rest.

---

## 🏗️ Technical Architecture

- **Core:** Manifest V3, JavaScript (ES6+).
- **Styling:** Custom CSS with variable-based design system.
- **Networking:** Asynchronous Proxy Fetching via Background Service Workers to bypass CORS limitations.
- **State Management:** Chrome Local Storage for persistent session restoration.

---

## 📜 License

Distributed under the MIT License. See `LICENSE` for more information.

---


