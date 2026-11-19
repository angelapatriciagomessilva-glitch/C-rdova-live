# Live VTuber — estúdio de live estilo OBS (Android)

Cenas e fontes (modelo VTuber, câmera, tela, imagem, texto, cor), mixer de áudio, gravação em vídeo e **transmissão RTMP** (Twitch, YouTube, Facebook ou qualquer servidor RTMP).

## Como gerar o APK
### Opção A — GitHub Actions (sem instalar nada)
1. Crie um repositório no github.com e envie TODO o conteúdo desta pasta (`app/`, `plugins-local/`, `config.xml`, `package.json`, `build-www.sh`, `.gitignore`).
2. **Add file → Create new file**, nome `.github/workflows/build-apk.yml` (digite as barras), cole o conteúdo do arquivo `build-apk.yml` desta pasta → Commit.
3. Aba **Actions → Compilar APK → Run workflow**. Em ~10 min, baixe `live-vtuber-apk` em *Artifacts* e instale o `.apk`.
4. Se aparecer ❌, abra o passo vermelho e me mande o erro.

### Opção B — no computador (Node, JDK 17, Android SDK)
```sh
npm install -g cordova
sh build-www.sh app
cordova platform add android@13
cordova plugin add cordova-plugin-android-permissions cordova-plugin-file cordova-plugin-x-socialsharing
cordova plugin add ./plugins-local/cordova-plugin-live-rtmp
cordova build android      # APK em platforms/android/app/build/outputs/apk/
```

## Usando
1. **Modelo** → *Abrir arquivo .vrig* (exporte do Rigger) ou use o de demonstração.
2. **Fontes** → *+ Modelo VTuber*, *Câmera*, *Imagem*, *Texto*, *Cor/fundo*. No palco: arraste para mover, cantos/pinça para o tamanho, bolinha rosa para girar.
3. **● Rastrear** liga o rosto → modelo (depois *Calibrar neutro*). **Áudio** → adicionar microfone.
4. **Transmissão**: escolha a plataforma, cole a **chave da transmissão** (Twitch: Painel do Criador → Configurações → Transmissão; YouTube: YouTube Studio → Transmitir ao vivo) e toque **📡 Ao vivo**.
5. **⏺ Gravar** salva um vídeo da cena (o app abre a folha de compartilhar para você guardar o arquivo).

## Limites (leia antes de uma live importante)
- O app precisa ficar **aberto e com a tela ligada** durante a transmissão (o Android pausa o WebView em segundo plano). Usamos “manter tela acesa” automaticamente.
- Captura de tela (`🖥 Tela`) não existe em WebView Android; funciona no Chrome do PC.
- Fazer vídeo H.264 + rastreio + modelo ao mesmo tempo pesa: em aparelhos fracos use 480p/720p a 30 fps e câmera 360p–480p.
- Faça um teste com uma live **não listada/privada** antes. O envio RTMP foi validado contra um servidor de teste, mas ainda não foi validado em aparelho Android real.
