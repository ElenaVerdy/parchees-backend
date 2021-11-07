module.exports = function(text) {
    const badPatterns = [
        '^(о|а)н(о|а)нист.*',
        '^лошар.*',
        '^к(а|о)злина$',
        '^к(о|а)зел$',
        '^сволоч(ь|ъ|и|уга|ам|ами).*',
        '^лох[уеыаоэяию].*',
        '.*урод(ы|у|ам|ина|ины).*',
        '.*бля(т|д).*', '.*гандо.*',
        '^м(а|о)нд(а|о).*',
        '.*сперма.*',
        '.*[уеыаоэяию]еб$',
        '^сучк(а|у|и|е|ой|ай).*',
        '^придур(ок|ки).*',
        '^д(е|и)би(л|лы).*',
        '^сос(ать|и|ешь|у)$',
        '^залуп.*',
        '^обосс.*',
        '^муд(е|ил|о|а|я|еб).*',
        '.*шалав(а|ы|ам|е|ами).*',
        '.*пр(а|о)ст(и|е)т(у|е)тк(а|и|ам|е|ами).*',
        '.*шлюх(а|и|ам|е|ами).*',
        '.*ху(й|и|я|е|л(и|е)).*',
        '.*п(и|е|ы)зд.*',
        '^бл(я|т|д).*',
        '(с|сц)ук(а|о|и|у).*',
        '^еб.*',
        '.*(д(о|а)лб(о|а)|разъ|разь|подъ|подь|за|вы|по)еб*.*',
        '.*пид(а|о|е)р.*',
        '.*хер.*'
    ]

    const goodPatterns = [
        '.*психу.*',
        '.*к(о|а)манд.*',
        '.*истр(е|и)блять.*',
        '.*л(о|а)х(о|а)трон.*',
        '.*(о|а)ск(о|а)рблять.*',
        'хул(е|и)ган',
        '.*м(а|о)нд(а|о)рин.*',
        '.*р(а|о)ссл(а|о)блять.*',
        '.*п(о|а)тр(е|и)блять.*',
        '.*@.*\\.(ру|сом|нет)$',
        '.*рубля*.'
    ]

    const goodWords = [
        'дезмонда',
        'застрахуйте',
        'одномандатный',
        'подстрахуй',
        'психуй'
    ]

    const letters = {
        'a': 'а',
        'b': 'в',
        'c': 'с',
        'e': 'е',
        'f': 'ф',
        'g': 'д',
        'h': 'н',
        'i': 'и',
        'k': 'к',
        'l': 'л',
        'm': 'м',
        'n': 'н',
        'o': 'о',
        'p': 'р',
        'r': 'р',
        's': 'с',
        't': 'т',
        'u': 'у',
        'v': 'в',
        'x': 'х',
        'y': 'у',
        'w': 'ш',
        'z': 'з',
        'ё': 'е',
        '6': 'б',
        '9': 'д'
    }

    const convertEngToRus = function (word) {
        for (var j = 0; j < word.length; j++) {
            for (var key in  letters) {
                if (word.charAt(j) == key) {
                    word = word.substring(0, j) + letters[key] + word.substring(j + 1, word.length)
                }
            }
        }

        return word
    }

    const wordsActual = text.split(' ')
    const words = text.replace(/[^a-zA-Zа-яА-Я0-9\s]/g, '').toLowerCase().split(' ')
    let ret = ''

    for (var i = 0; i < words.length; i++) {
        var word = convertEngToRus(words[i])

        if (~goodWords.indexOf(word) || goodPatterns.some(pattern => new RegExp(pattern).test(word))) {
            ret += ret ? ' ' + wordsActual[i] : wordsActual[i]
            continue
        }

        if (badPatterns.some(pattern => new RegExp(pattern).test(word))) {
            ret += ret ? ' ' + '*'.repeat(wordsActual[i].length) : '*'.repeat(wordsActual[i].length)
            continue
        }
        ret += ret ? ' ' + wordsActual[i] : wordsActual[i]
    }
    if (!~goodWords.indexOf(ret)
        && !goodPatterns.some(pattern => new RegExp(pattern).test(ret))
        && (~badPatterns.indexOf(ret) || badPatterns.some(pattern => new RegExp(pattern).test(ret)))) {
        return '***censored***'
    }

    return ret
}
