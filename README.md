# Moondrop HID

Thư viện JavaScript/TypeScript để kết nối, đọc và ghi cấu hình DAC Moondrop qua WebHID.
Chạy trên trình duyệt hỗ trợ WebHID.

## Cài đặt

Thêm vào `.npmrc` của ứng dụng:

```ini
@shio265:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

Đặt GitHub PAT **classic** có quyền `read:packages` vào biến môi trường
`GITHUB_PACKAGES_TOKEN`, rồi cài gói:

```sh
bun add @shio265/moondrop-hid
```

## Ví dụ sử dụng

HTML:

```html
<button id="connect">Kết nối và đọc cấu hình</button>
<button id="save">Ghi EQ</button>
<button id="disconnect">Ngắt kết nối</button>
```

JavaScript, chạy sau khi các nút đã có trong trang:

```js
import { createClient } from '@shio265/moondrop-hid';

const dac = createClient();

document.querySelector('#connect').onclick = async () => {
  try {
    const device = await dac.connect();
    if (!device) return; // Người dùng hủy chọn thiết bị

    console.log('Thiết bị:', device.model);
    if (device.capabilities.supportsRead) {
      console.log(await dac.readConfig());
    }
  } catch (error) {
    console.error(error);
  }
};

document.querySelector('#save').onclick = async () => {
  try {
    const result = await dac.writeConfig({
      filters: [{ type: 'PK', freq: 1000, gain: -3, q: 1 }],
      globalGain: 0
    });
    console.log(result);
  } catch (error) {
    console.error(error);
  }
};

document.querySelector('#disconnect').onclick = () =>
  dac.disconnect().catch(console.error);
```

## Lưu ý

- Gọi `connect()` từ thao tác bấm của người dùng. Kết nối không tự ghi cấu hình.
- Ví dụ ghi một band EQ tại 1000 Hz, giảm 3 dB. **Các band còn lại được đặt về phẳng**, thay thế toàn bộ custom bank.
- Không phải thiết bị nào cũng hỗ trợ đọc cấu hình. Kiểm tra `dac.device.limits` để biết giới hạn band.
- Giảm âm lượng trước khi thử. Gửi lệnh ghi thành công chưa đảm bảo dữ liệu đã lưu đúng; nên đọc lại nếu thiết bị hỗ trợ.

## Phát triển và phát hành

Cần Bun 1.4.3 trở lên. Thư viện được build bằng [Bunup](https://bunup.dev/):

```sh
bun install --frozen-lockfile
bun run check
bun pm pack
```
