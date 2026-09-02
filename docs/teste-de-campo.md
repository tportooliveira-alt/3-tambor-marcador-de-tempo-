# Primeiro teste no aparelho — roteiro de uma noite

Objetivo desta primeira noite: **descobrir o que o SEU aparelho entrega**. Não é medir cavalo ainda —
é responder três perguntas que só o hardware responde:

1. Qual modo a sonda escolhe (240 / 120 / 60 / 30 FPS) e se ele **se mantém** depois de travar a exposição.
2. Se a faixa dispara de forma confiável com um objeto real cruzando.
3. Que qualidade de refinamento aparece com pixels reais (2 = milésimo, 1 = intervalo, 0 = quadro).

Anote os números pedidos no fim. São eles que dizem o que ajustar antes da pista.

---

## 1. Instalar

### Android (Android Studio)
```bash
git clone <este repositório> && cd 3-tambor-marcador-de-tempo-/android
# abrir a pasta `android` no Android Studio (Ladybug ou mais novo) e deixar sincronizar,
# ou pela linha de comando, com o SDK instalado:
./gradlew :app:installDebug        # instala no aparelho conectado (depuração USB ligada)
```
Se o Studio pedir para instalar o SDK 35 e o Build-Tools, aceite. O app não precisa de assinatura nem
de conta: é build de depuração.

### iOS (Mac com Xcode 15+)
```bash
cd ios && open FotocelulaTambor.xcodeproj      # ou ./bootstrap.sh se o projeto não abrir
```
No alvo → **Signing & Capabilities** → Team = seu Apple ID (gratuito serve, o app vale 7 dias).
No iPhone: **Ajustes → Privacidade e Segurança → Modo Desenvolvedor** ligado.
Rode em **Release** (Product → Scheme → Edit Scheme → Run → Build Configuration = Release):
em Debug o laço da faixa é 10–50× mais lento.

---

## 2. Primeira abertura (2 minutos, em casa)

Segure o celular **deitado (paisagem)**. Dê a permissão de câmera.

Olhe a primeira linha dos diagnósticos: ela diz o **formato e o modo escolhidos** e, entre parênteses,
a taxa **medida**. Anote os dois.

- Android: se a sonda escolher alta velocidade e a superfície não entregar a taxa, o app **cai sozinho**
  para a sessão normal e mostra o aviso. Anote o texto do aviso, se aparecer.
- Samsung: é esperado 30 FPS (a fabricante não libera 120/240 para apps de terceiros). O app avisa.

Depois toque em **Calibrar** com a cena parada. Ao terminar, a linha da exposição mostra
`Exposição 1/x s · ISO y · foco … · skew …`. Anote exposição, ISO e skew.

> **Atenção à luz de casa.** À noite, sob lâmpada de rede, a cena pisca a 120 Hz e o ISO sobe. Isso é
> exatamente um bom teste: o app deve detectar o flicker sozinho (badge roxo "Flicker 120 Hz") e passar
> a comparar cada quadro com o de mesma fase. Se o badge não aparecer sob lâmpada, anote.

---

## 3. Teste de bancada (sem cavalo)

Em **Ajustes**, toque em **Modo teste** — isso encurta as janelas (bloqueio 0,5 s, retomada 1,5 s,
chegada armada aos 2 s), para você repetir uma "prova" a cada poucos segundos em vez de esperar 10 s.
**Antes da pista, volte para Modo prova.**

Montagem: celular no tripé (ou apoiado, firme), a ~2 m de uma parede clara. A faixa (retângulo verde na
tela) deve pegar uma região **uniforme** do fundo.

1. **Calibrar** com nada passando. O medidor de ΔY fica baixo e o limiar aparece.
2. **Armar**. O retângulo fica vermelho (ROI travada).
3. Passe o **braço** (ou um cabo de vassoura, melhor: mais parecido com um bordo vertical) cruzando a
   faixa, rápido, da esquerda para a direita → bipe + flash + cronômetro correndo.
4. Espere os 2 s e cruze de novo, **no sentido contrário** → segundo bipe, tempo final na tela.
5. Repita 10 vezes. Some rápido, apague o que for lixo com "Excluir" no Histórico.

O que observar em cada passada, no cartão do resultado:

| Campo | O que significa |
|---|---|
| `Refinado` vs `bruto` | a diferença entre eles é o refinamento sub-quadro; devem estar a poucos ms |
| `Qualidade 2 (±0,xx ms)` | milésimo confiável — é o que queremos |
| `Qualidade 1 (±x,x ms)` | intervalo honesto: o app **sabe** que não conseguiu fechar; ainda serve |
| `Qualidade 0 (±7,6 ms)` | só o tempo do quadro; a banda pegou textura, contraste baixo ou pouca luz |
| `DEGRADADA` | houve quadro perdido perto do gatilho |

**Se sair muito q0/q1:** suba ou desça as alças da banda para pegar uma faixa mais uniforme do objeto,
acenda mais luz, e confira nos diagnósticos se a exposição travou curta. É exatamente esse ajuste que
vamos repetir na pista com o cavalo.

---

## 4. Verificações que valem ouro (ainda em casa)

**a) A taxa se mantém depois de travar?** Diagnósticos: a taxa medida tem de continuar igual à do modo.
Se cair (ex.: 240 → 180), a exposição travada alongou o quadro: escolha uma exposição menor em Ajustes
e calibre de novo. O app **bloqueia Armar** nesse caso e diz o motivo — anote a mensagem.

**b) Dez minutos armado.** Deixe armado, sem passar nada, e olhe o badge térmico. Anote quanto tempo
leva para sair de "Térmico OK". (No iPhone, com Modo Pouca Energia **desligado**.)

**c) Retomada dos quadros.** Em Modo prova, dispare a largada e veja se a taxa volta ao normal antes de
a chegada armar (aos 10 s). Se a taxa demorar a voltar, anote.

**d) O teste do milésimo (LED a 1,000 Hz).** É o único jeito de provar o ΔT sem fotocélula de verdade:
ponha um LED (ou a tela de outro celular com um app de estrobo) piscando a **1,000 Hz** cruzando a
faixa, e confira se o tempo entre dois piscos dá **1,000 ± 0,001 s** no refinado. Se der 1,000 ± 0,004,
o refinamento não está entrando (q0) — anote a qualidade que apareceu.

---

## 4b. Se quiser já testar o modo prova (5 minutos)

Ainda em **Modo teste**, toque em **Prova**:

1. Crie um evento ("Teste de casa").
2. Em **Inscrições**, adicione 3 linhas (nº 1, 2, 3 com nomes quaisquer e uma categoria "A").
   Se quiser testar a importação, salve um arquivo `.csv` com:
   ```
   1;Ana;Estrela;A
   2;Bruno;Trovão;A
   3;Carla;Luna;B
   ```
   e use **Importar CSV**.
3. Volte à tela principal: a faixa **PRÓXIMO: #1 Ana / Estrela — A** aparece em cima do preview.
4. Faça 3 "passadas" com o braço. Em cada resultado, toque em **Salvar para #n** — a faixa avança
   sozinha para o próximo. Numa delas, marque 1 tambor; noutra, marque SAT.
5. Em **Prova → Classificação**, confira: quem derrubou tambor levou +5 s e caiu de posição; o SAT
   ficou por último sem colocação.
6. Em **Prova → Backup**, escolha uma pasta do Drive/Arquivos e confira que o arquivo
   `fotocelula-historico.csv` aparece lá e é reescrito a cada passada salva.
7. Feche o app pelo gerenciador de tarefas e abra de novo: evento, inscrições e histórico têm de
   continuar lá.

## 5. O que anotar para amanhã

Copie estas linhas e preencha:

```
Aparelho / sistema:
Modo escolhido pela sonda:                (ex.: 240 FPS alta velocidade)
Taxa medida antes de calibrar:            FPS
Taxa medida depois de travar:             FPS
Exposição travada / ISO / skew:           1/x s  /  y  /  z ms
Badge de flicker apareceu sob lâmpada?    sim / não
10 passadas de bancada: qualidades        (ex.: 2,2,1,2,0,2,2,1,2,2)
Incerteza típica na qualidade 2:          ±0,xx ms
Alguma passada DEGRADADA?                 quantas
Mensagem de bloqueio ao armar (se houve):
Tempo até sair de "Térmico OK":           min
LED 1,000 Hz → tempo medido:              s  (qualidade   )
Modo prova: importação de CSV / faixa "Próximo" / classificação / backup:  ok? o que falhou?
```

Com isso eu ajusto o app para a pista: largura da faixa, exposição padrão, altura da banda e os limites
de aviso. **Exporte o CSV do Histórico** (botão "Exportar CSV") e me mande — ele traz incerteza,
qualidade, limiar, drops e exposição de cada passada.

---

## 6. O que já é esperado (não é defeito)

- **Menos qualidade 2 à noite**: pouca luz → ISO alto → ruído alto → o app prefere o intervalo honesto.
  Na pista, de dia, a expectativa é o contrário.
- **Qualidade 0 com objeto texturizado**: pelagem malhada, peiteira e arreios dentro da banda derrubam o
  refinamento de propósito — o app não inventa precisão. A banda deve pegar peito ou pescoço uniforme.
- **Foco contínuo em alta velocidade no Android**: a sessão restrita do sistema **impõe** foco contínuo;
  o app mostra isso nos diagnósticos. Enquadre a cena antes de armar e evite mexer no tripé.
- **Bruto e refinado diferentes por alguns ms**: é o refinamento fazendo o trabalho dele. O que vale é
  o refinado, com a incerteza ao lado.
