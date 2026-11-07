# Discord Vanity URL Sniper

Discord vanity URL'lerini anlık takip eden ve düşer düşmez otomatik alan Node.js CLI aracı. Hiçbir harici kütüphane gerekmez — saf Node.js.

---

## Ne Yapar?

Discord sunucularının özel URL'leri (örn: `discord.gg/valorant`) vardır. Bu URL'ler bazen serbest bırakılır. Bu araç:

- Hesabınıza bağlı tüm sunucuların URL'lerini **anlık izler**
- Bir URL düştüğü anda **otomatik alır**
- **7/24 çalışır** — çökerse kendiliğinden yeniden başlar
- **Webhook ile bildirim** gönderir — URL alındığında @everyone ping atar

---

## Gereksinimler

- **Node.js v22+** → [nodejs.org](https://nodejs.org) adresinden indir
- Discord hesabında **2FA (Google Authenticator)** aktif olmalı
- Almak istediğin sunucuda **Sunucuyu Yönet** yetkisi olmalı

---

## Kurulum

```bash
git clone https://github.com/ravenvdev/discord-vanity-sniper-mfa-fix.git
cd discord-vanity-sniper-mfa-fix
node sniper.js
```

İlk açılışta menüden token, TOTP kodu ve sunucu ID'sini gir. `.state.json` dosyasına kaydedilir — bir daha sormaz.

---

## Bilgileri Nasıl Alırsın?

### Discord User Token

1. Discord'u **tarayıcıda** aç (uygulama değil)
2. **F12** → **Network** sekmesi
3. Herhangi bir mesaj gönder veya kanal değiştir
4. Çıkan isteklerden birine tıkla → **Request Headers** kısmında `Authorization` satırını kopyala

> Token'ını kimseyle paylaşma. Hesabına tam erişim sağlar.

### TOTP Secret (Base32 Anahtar)

2FA kurulurken Discord sana hem QR kodu hem de **yazılı bir anahtar** gösterir:

```
65OP EMVR AWXM DYMR O2LZ 6O5C RO73 L3C4
```

Bu anahtarı **boşluksuz ve küçük harfle** gir:
```
65opemvrawxmdymro2lz6o5cro73l3c4
```

> Anahtarı kaydetmediysen 2FA'yı kapatıp tekrar açman gerekir.

### Sunucu ID

1. Discord → Ayarlar → Gelişmiş → **Geliştirici Modu** aç
2. Sunucu ikonuna sağ tıkla → **Sunucu ID'sini Kopyala**

### Webhook URL (İsteğe Bağlı)

1. Sunucu Ayarları → **Entegrasyonlar → Web Kancaları → Yeni Web Kancası**
2. Kanal seç → **Web Kancası URL'sini Kopyala**
3. Sniper menüsünden 5. seçenekle kaydet

---

## Menü

```
════════════════════════════════
   Discord Vanity Sniper
════════════════════════════════
 1 › Token gir / değiştir
 2 › Tüm vanity URL'leri listele
 3 › Tek URL snipe
 4 › AUTO-SCAN (tüm urleri izle)
 5 › Webhook ayarla
 6 › TOTP secret temizle
 7 › Çıkış
```

| Seçenek | Ne Yapar |
|---|---|
| 1 | Token gir veya güncelle |
| 2 | Hesabındaki tüm sunucuları ve URL'lerini listeler |
| 3 | Tek bir URL'yi izler, düşünce belirttiğin sunucuya alır |
| 4 | Tüm URL'leri aynı anda izler, ilk düşeni alır ve durur |
| 5 | Webhook URL'si kaydet — URL alınınca @everyone atar |
| 6 | TOTP secret'ı sil (2FA sıfırladıysan kullan) |
| 7 | Kapat |

---

## 7/24 Çalıştırma (Watchdog)

`watchdog.bat` dosyasına çift tıkla. Sniper otomatik başlar, herhangi bir sebepten kapanırsa 5 saniye sonra kendiliğinden yeniden açılır.

```
Sniper çalışıyor...
  ↓ crash / kapanma
5 saniye bekle
  ↓
Sniper tekrar başlıyor...
  ↓
... sonsuza kadar
```

- Yeniden başlamalar `logs\restarts.log` dosyasına kaydedilir
- Durdurmak için pencereyi kapat veya `Ctrl+C`

---

## Nasıl Çalışır?

### Neden Anlık? (Gateway)

Çoğu sniper her birkaç saniyede bir Discord'a "URL hâlâ var mı?" diye sorar. Bu yavaştır ve rate limit yer.

Bu araç Discord'un **Gateway WebSocket**'ine bağlanır — sunucu sahibi URL'yi sildiği **aynı milisaniyede** event alır. Polling yok, gecikme yok.

### MFA Sistemi

Discord, URL değiştirmek için **2FA doğrulaması** ister. Araç bunu otomatik halleder:

1. TOTP kodu üretir (Google Authenticator ile aynı algoritma)
2. MFA token alır
3. URL claim ederken bu token'ı kullanır
4. Token **her 2 dakikada bir otomatik yenilenir** — 7/24 beklerken hiçbir zaman expire olmaz

### HTTP/2 (Cloudflare Bypass)

Node.js'in varsayılan `fetch()` fonksiyonu Cloudflare tarafından bot olarak algılanır ve **1015 hatası** döndürür. Araç bunun yerine `node:http2` modülünü doğrudan kullanır — gerçek bir tarayıcı gibi görünür.

---

## Sorun Giderme

| Hata | Neden | Çözüm |
|---|---|---|
| `Token geçersiz` | Token süresi dolmuş | Tarayıcı DevTools'dan tekrar kopyala |
| `MFA hatası` | TOTP secret yanlış | Menü 6 → temizle → tekrar gir |
| `1015 Cloudflare` | IP rate limit | 1 dakika bekle, otomatik düzelir |
| `Gateway bağlantı hatası` | Internet kesildi | Watchdog otomatik yeniden başlatır |
| `Vanity URL yok` | Sunucu Seviye 3 değil | Normal — listede `-` olarak görünür |

---

## Dosya Yapısı

```
discord-vanity-sniper-mfa-fix/
├── sniper.js              # Ana program — tüm mantık burada
├── watchdog.bat           # 7/24 otomatik yeniden başlatma
├── start.bat              # Basit başlatıcı (çift tıkla)
├── package.json
├── .gitignore             # .state.json ve logs/ hariç tutulur
├── .state.json.example    # Credential şablonu
└── README.md
```

---

## Güvenlik

- `.state.json` → `.gitignore`'da — asla commit'e girmez
- Token'ını kimseyle paylaşma
- Sürekli açık bırakmak için kişisel bilgisayar yerine **VPS kullanmak** daha güvenli

---

## Sorumluluk Reddi

Bu araç Discord Kullanım Şartları'nı ihlal eder. Kullanım sorumluluğu tamamen size aittir. Hesap askıya alma veya kalıcı ban durumlarında geliştirici sorumlu tutulamaz.

---

## Lisans

MIT
