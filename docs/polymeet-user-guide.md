# PolyMeet 使用者操作手冊 · User Guide

![UNI-PRESIDENT VIETNAM CO., LTD.](../src/client/assets/uni-president-vietnam.png)

**UNI-PRESIDENT VIETNAM CO., LTD. · 2026**

繁體中文 · 简体中文 · Tiếng Việt · English

## 繁體中文 | 使用者操作手冊

### 1. 登入與設定

1. 開啟管理員提供的 PolyMeet 網址。用「介面語言」切換顯示語言，輸入個人帳號及密碼後按「登入」。登入後可在「設定」切換介面語言，在側邊欄按「改密碼」。
2. 「設定」中的「功能模型配置」可分別指定即時轉錄、音檔轉錄、即時雙語翻譯與會議紀錄的供應商和模型。若帳號可以使用系統金鑰，可直接使用。若需個人 API 金鑰，請填入對應欄位後按「儲存設定」。只有勾選記住金鑰才會跨分頁保留。

### 2. 建立會議並錄音

1. 按「新增會議」，輸入會議名稱後選擇「一般會議」或「雙語會議」。設定逐字稿語言。雙語會議需選擇兩種不同語言，系統會把各段譯成另一種語言。
2. 選擇「僅麥克風」或「麥克風 + 分頁音訊」。要同步轉錄請勾選「啟用即時轉錄」。按「開始錄音」並授予麥克風權限。要擷取分頁聲音，請在瀏覽器對話框選取有聲音的分頁，並啟用音訊分享。
3. 錄音時可「暫停」或「繼續」。完成後按「停止錄音」並等候保存。錄音期間若需重新整理，請使用「儲存錄音並重整」。

### 3. 逐字稿、翻譯與投影

1. 已定稿的文字出現在「逐字稿」。可搜尋原文與譯文、編輯原文或更名語者。修改原文後，可按「重新翻譯」更新譯文。雙語會議可按「補齊未譯段落」處理缺漏。
2. 要向與會者展示字幕，按「投影字幕」。在投影畫面按 F 切換全螢幕，按 + 或 - 調整字級。逐字稿可下載為 MD 或 TXT，字幕可下載為 SRT 或 VTT。

### 4. 轉錄現有音檔

在「逐字稿」按「上傳音檔」並選擇檔案，或在錄音播放器按「轉錄此錄音」。若該錄音已有逐字稿，可選擇附加新段落或在成功後覆蓋。要保留現有內容，請選擇附加。完成後核對語者、文字及時間位置。

### 5. 生成與匯出 AI 會議紀錄

1. 在「會議筆記」補上議程、決議或行動項目。切換到「AI 紀錄」，選擇「僅潤飾」或「翻譯並潤飾」，確認輸出語言與樣式後按「生成 AI 紀錄」。
2. 核對人名、數字、決議與待辦事項。編輯完成可「儲存為版本」，也可複製內容或下載 MD、TXT、JSON。

### 6. 查詢時間與費用

停止錄音或完成支援用量紀錄的 AI 操作後，可從用量摘要查看使用時間、模型 Token 數及費用。按「費用紀錄」可按日期與金鑰來源查詢。缺少費率或供應商用量的項目會標為待核對。具管理員權限者可在「管理後台」查閱和核對使用系統金鑰的用量。

### 7. 備份與還原

1. 從側邊欄開啟「資料備份」。選擇當前會議或全部會議的匯出範圍，需要保留音訊時，確認勾選「包含錄音音檔」，再按「下載備份」並妥善保存 .polymeet 檔。
2. 換裝置或瀏覽器時，登入目標帳號，再到「匯入備份」選取之前下載的檔案並按「匯入會議」。會議會以新副本加入工作區。逐字稿、紀錄和錄音平時保存在目前的瀏覽器工作區。轉錄、翻譯與 AI 紀錄會把相關音訊或文字傳送到所選供應商。

### 8. 常見狀況

- **收不到音訊**：檢查網址、瀏覽器權限、麥克風和分頁分享。從其他裝置開啟時，請使用瀏覽器信任的 HTTPS 網址。
- **逐字稿或譯文延遲**：先確認即時轉錄已連線。停頓若持續有背景音，提交可能較慢。若原文已定稿，請確認翻譯服務與金鑰；錄音結束後可補齊未譯段落。
- **即時轉錄中斷**：讓錄音完成並保存，再用「轉錄此錄音」補轉。關閉頁面前確認錄音已保存，有重要資料時先備份。

## 简体中文 | 用户操作手册

### 1. 登录与设置

1. 打开管理员提供的 PolyMeet 网址。使用「界面语言」切换显示语言，输入个人账号和密码后点击「登录」。登录后可在「设置」切换界面语言，在侧边栏点击「改密码」。
2. 「设置」中的「功能模型配置」可分别指定实时转写、音频文件转写、实时双语翻译和会议纪要的服务商与模型。如果账号有权使用系统密钥，可直接使用。若需要个人 API 密钥，请填入对应字段并点击「保存设置」。勾选记住密钥后，密钥才会在其他标签页中保留。

### 2. 创建会议并录音

1. 点击「添加会议」，输入会议名称并选择「一般会议」或「双语会议」。设置逐字稿语言。双语会议需要选择两种不同语言，系统会将各段译为另一种语言。
2. 选择「仅麦克风」或「麦克风 + 标签页音频」。要同步转写，请勾选「激活实时转写」。点击「开始录音」并授予麦克风权限。要采集标签页声音，请在浏览器对话框中选择有声音的标签页并启用音频分享。
3. 录音中可「暂停」或「继续」。完成后点击「停止录音」并等待保存。录音期间如需刷新，请点击「保存录音并刷新」。

### 3. 逐字稿、翻译与投影

1. 定稿文字显示在「逐字稿」。可以搜索原文和译文、编辑原文或修改说话人名称。修改原文后，点击「重新翻译」更新译文。双语会议可使用「补齐未译段落」处理缺漏。
2. 要向参会者展示字幕，点击「投影字幕」。在投影界面按 F 切换全屏，按 + 或 - 调整字号。逐字稿可以下载为 MD 或 TXT，字幕可以下载为 SRT 或 VTT。

### 4. 转写已有音频

在「逐字稿」点击「上传音档」并选择文件，或在录音播放器中点击「转写此录音」。如果该录音已有逐字稿，可选择追加新段落或在成功后覆盖。若要保留现有内容，请选择追加。完成后核对说话人、识别文字和时间位置。

### 5. 生成与导出 AI 会议纪要

1. 在「会议笔记」补充议程、决议或行动事项。切换到「AI 记录」，选择「仅润饰」或「翻译并润饰」，确认输出语言与样式，然后点击「生成 AI 纪录」。
2. 核对人名、数字、决议和待办事项。编辑完成后可以保存为版本，也可以复制内容或下载 MD、TXT、JSON。

### 6. 查询时长和费用

停止录音或完成支持用量记录的 AI 操作后，可从用量摘要查看使用时长、模型 Token 数和费用。点击「费用纪录」可按日期和密钥来源查询。缺少费率或服务商用量的项目会标为待核对。管理员可以在「管理后台」查看和核对使用系统密钥的用量。

### 7. 备份与恢复

1. 从侧边栏打开「数据备份」。选择当前会议或全部会议作为导出范围，如需保留声音，确认已勾选包含录音文件，再点击「下载备份」并妥善保存 .polymeet 文件。
2. 更换设备或浏览器时，登录目标账号，在「导入备份」选择之前下载的文件并导入会议。会议会作为新副本加入工作区。逐字稿、纪要和录音平时保存在当前浏览器的工作区。转写、翻译及生成 AI 纪要会将相关音频或文字发送给所选服务商。

### 8. 常见情况

- **采集不到声音**：检查网址、浏览器权限、麦克风和标签页分享。从其他设备打开时，请使用浏览器信任的 HTTPS 网址。
- **逐字稿或译文延迟**：先确认实时转写已连接。停顿期间如果持续有背景声，提交可能较慢。如果原文已定稿，请检查翻译服务与密钥；录音结束后可以补齐未译段落。
- **实时转写中断**：完成并保存录音，再通过「转写此录音」补转。关闭页面前确认录音已经保存，重要资料应先备份。

## Tiếng Việt | Hướng dẫn sử dụng

### 1. Đăng nhập và cài đặt

1. Mở địa chỉ PolyMeet do quản trị viên cung cấp. Dùng **Ngôn ngữ giao diện** để đổi ngôn ngữ, nhập tài khoản và mật khẩu cá nhân rồi chọn **Đăng nhập**. Sau khi đăng nhập, bạn có thể đổi ngôn ngữ trong **Cài đặt** và đổi mật khẩu từ thanh bên.
2. Trong **Cài đặt**, chọn nhà cung cấp và mô hình cho từng chức năng chép lời trực tiếp, chép lời tệp âm thanh, dịch song ngữ và tạo biên bản. Nếu tài khoản được cấp quyền dùng khóa hệ thống, có thể sử dụng ngay. Nếu cần khóa API cá nhân, nhập khóa vào ô tương ứng rồi lưu. Chỉ bật tùy chọn ghi nhớ khóa nếu muốn giữ khóa khi mở tab khác.

### 2. Tạo cuộc họp và ghi âm

1. Chọn **Tạo cuộc họp**, đặt tên rồi chọn **Họp thông thường** hoặc **Họp song ngữ**. Chọn ngôn ngữ chép lời. Với cuộc họp song ngữ, chọn hai ngôn ngữ khác nhau để mỗi đoạn được dịch sang ngôn ngữ còn lại.
2. Chọn **Chỉ micrô** hoặc **Micrô + âm thanh thẻ**. Chọn **Bật chép lời trực tiếp** nếu cần. Nhấn **Bắt đầu ghi âm** và cấp quyền micrô. Khi thu âm thanh từ tab, chọn tab có tiếng và bật chia sẻ âm thanh trong hộp thoại của trình duyệt.
3. Dùng **Tạm dừng** hoặc **Tiếp tục** khi cần. Khi kết thúc, chọn **Dừng ghi âm** và chờ lưu. Nếu cần tải lại trong lúc ghi, chọn **Lưu bản ghi và tải lại**.

### 3. Bản chép lời, bản dịch và phụ đề

1. Tìm kiếm, sửa lời gốc hoặc đổi tên người nói trong bản chép lời. Sau khi sửa lời gốc, chọn **Dịch lại**. Trong cuộc họp song ngữ, dùng **Dịch các đoạn còn thiếu** để bổ sung bản dịch.
2. Chọn **Chiếu phụ đề** để hiển thị cho người tham dự. Trong màn hình chiếu, nhấn F để bật hoặc tắt toàn màn hình, nhấn + hoặc - để đổi cỡ chữ. Tải bản chép lời dưới dạng MD hoặc TXT, và phụ đề dưới dạng SRT hoặc VTT.

### 4. Chép lời âm thanh có sẵn

Chọn **Tải tệp âm thanh lên** trong khu vực bản chép lời, hoặc **Chép lời bản ghi** trong trình phát. Nếu bản ghi đã có bản chép lời, chọn nối thêm các đoạn hoặc thay thế sau khi chép lời thành công. Để giữ nội dung hiện có, chọn nối thêm. Kiểm tra nội dung, người nói và mốc thời gian sau khi hoàn tất.

### 5. Tạo và xuất biên bản AI

1. Nhập chương trình họp, quyết định hoặc việc cần làm vào **Ghi chú cuộc họp**. Mở **Biên bản AI**, chọn **Chỉ biên tập** hoặc **Dịch và biên tập**. Chọn ngôn ngữ đầu ra và kiểu biên bản, rồi nhấn **Tạo biên bản AI**.
2. Kiểm tra tên, số liệu, quyết định và việc cần làm. Lưu bản đã chỉnh sửa thành một phiên bản, sao chép nội dung hoặc tải xuống dưới dạng MD, TXT hay JSON.

### 6. Xem thời lượng và chi phí

Sau khi dừng ghi âm hoặc hoàn thành tác vụ AI có ghi nhận mức sử dụng, xem thời lượng, số token theo mô hình và chi phí trong phần tổng hợp. Mở **Mức sử dụng và chi phí** để lọc theo ngày và nguồn khóa. Các mục thiếu đơn giá hoặc số liệu từ nhà cung cấp sẽ chờ đối soát. Quản trị viên có thể kiểm tra mức sử dụng khóa hệ thống trong trang quản trị.

### 7. Sao lưu và khôi phục

1. Mở **Sao lưu dữ liệu** ở thanh bên. Chọn xuất cuộc họp hiện tại hoặc toàn bộ cuộc họp, bật tùy chọn kèm tệp ghi âm nếu cần, rồi nhấn **Tải bản sao lưu** và lưu tệp .polymeet.
2. Khi đổi thiết bị hoặc trình duyệt, đăng nhập tài khoản đích và mở **Nhập bản sao lưu**, chọn tệp đã tải và nhập cuộc họp. Cuộc họp được thêm dưới dạng bản sao mới. Bản ghi âm, bản chép lời và biên bản được lưu trong không gian làm việc của trình duyệt hiện tại. Khi bạn dùng chức năng AI, âm thanh hoặc văn bản liên quan được gửi đến nhà cung cấp đã chọn.

### 8. Xử lý sự cố thường gặp

- **Không có âm thanh**: Kiểm tra địa chỉ trang, quyền trình duyệt, micrô và chia sẻ âm thanh tab. Khi truy cập từ thiết bị khác, dùng địa chỉ HTTPS được trình duyệt tin cậy.
- **Chép lời hoặc dịch chậm**: Kiểm tra kết nối chép lời. Tiếng nền trong lúc ngừng nói có thể làm chậm việc chốt đoạn. Nếu lời gốc đã hoàn tất, kiểm tra dịch vụ dịch và khóa API. Bạn có thể bổ sung bản dịch sau khi ghi âm.
- **Chép lời trực tiếp bị gián đoạn**: Hoàn tất và lưu bản ghi, sau đó chọn **Chép lời bản ghi**. Kiểm tra bản ghi đã lưu trước khi đóng trang và sao lưu nội dung quan trọng.

## English | User Guide

### 1. Sign in and configure your workspace

1. Open the PolyMeet address supplied by your administrator. Use **Interface language** to choose a display language, then enter your personal username and password and select **Sign in**. Change the interface language under **Settings** and your password from the sidebar.
2. In **Settings**, choose a provider and model for live transcription, file transcription, live bilingual translation, and meeting minutes. If your account can use a system key, you can start with the configured provider. If you need a personal API key, enter it in the matching field and save. Enable the remember-keys option only if you want the key to persist across tabs.

### 2. Create a meeting and record

1. Select **New meeting**, name it, and choose **Standard meeting** or **Bilingual meeting**. Set the transcript language. For a bilingual meeting, choose two different languages so that each segment can be translated into the other language.
2. Choose **Microphone only** or **Microphone + tab audio**. Turn on **Enable live transcription** if needed. Select **Start recording** and grant microphone access. For tab audio, select the tab that is playing sound and enable audio sharing in the browser prompt.
3. Use **Pause** or **Resume** during the meeting. When finished, select **Stop recording** and wait for it to save. If you need to reload during a recording, select **Save and reload**.

### 3. Work with transcripts, translations, and captions

1. Search the transcript, edit source text, or rename a speaker. After editing source text, select **Translate again** if you need an updated translation. In a bilingual meeting, select **Translate missing segments** to fill gaps.
2. Select **Project captions** to show captions to participants. In the projection view, press F to toggle full screen or + and - to change the text size. Download transcripts as MD or TXT and captions as SRT or VTT.

### 4. Transcribe existing audio

Select **Upload audio** in the transcript panel, or select **Transcribe recording** in the recording player. If a recording already has a transcript, choose to append new segments or replace the existing transcript after a successful transcription. Append to preserve the existing text. Check the text, speaker names, and timing afterward.

### 5. Generate and export AI meeting minutes

1. Add an agenda, decisions, or action items in **Meeting notes**. Open **AI minutes** and choose **Polish only** or **Translate and polish**. Set the output language and style, then select **Generate AI minutes**.
2. Review names, figures, decisions, and action items. Save edited minutes as a version, copy the text, or download it as MD, TXT, or JSON.

### 6. Review time and costs

After stopping a recording or finishing an AI task that records usage, review the summary for time, token counts by model, and costs. Open **Usage and costs** to filter by date and key source. Entries with missing rates or provider usage stay pending for reconciliation. Administrators can review and reconcile system-key usage in the admin area.

### 7. Back up and restore meeting data

1. Open **Data backup** from the sidebar. Choose whether to export the current meeting or all meetings, enable the audio option if needed, then select **Download backup** and keep the .polymeet file.
2. On another device or browser, sign in to the intended account and open **Import backup**, select the saved file, and import the meeting. It is added as a new copy. Recordings, transcripts, and minutes are stored in the current browser workspace. Transcription, translation, and AI minutes send the relevant audio or text to the selected provider.

### 8. Troubleshooting

- **No audio**: Check the site address, browser permissions, microphone, and tab audio sharing. When connecting from another device, use an HTTPS address trusted by your browser.
- **Delayed transcript or translation**: Check that live transcription is connected. Background sound during a pause may delay a segment. If the source text is already final, check the translation service and key. You can fill in missing translations after recording.
- **Interrupted live transcription**: Finish and save the recording, then select **Transcribe recording**. Confirm that the recording has saved before closing the page and back up important meetings.

---

© 2026 UNI-PRESIDENT VIETNAM CO., LTD. All rights reserved.
