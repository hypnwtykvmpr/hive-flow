# Hello World Function - Pseudocode

## Main Function Logic

```
FUNCTION helloWorld(options = {})
  // Step 1: Extract and validate parameters
  name = options.name OR getDefaultName()
  language = options.language OR getDefaultLanguage()
  format = options.format OR 'plain'
  
  // Step 2: Validate inputs
  IF NOT isValidLanguage(language) THEN
    THROW InvalidLanguageError
  END IF
  
  IF name AND NOT isValidName(name) THEN
    THROW InvalidNameError
  END IF
  
  // Step 3: Get localized greeting
  greeting = getGreeting(language, name)
  
  // Step 4: Format output
  SWITCH format
    CASE 'json':
      RETURN formatAsJson(greeting, language, name)
    CASE 'html':
      RETURN formatAsHtml(greeting)
    DEFAULT:
      RETURN greeting
  END SWITCH
END FUNCTION

## Helper Functions

FUNCTION getDefaultName()
  RETURN process.env.DEFAULT_NAME OR 'World'
END FUNCTION

FUNCTION getDefaultLanguage()
  RETURN process.env.DEFAULT_LANGUAGE OR 'en'
END FUNCTION

FUNCTION isValidLanguage(language)
  RETURN language IN ['en', 'es', 'fr']
END FUNCTION

FUNCTION isValidName(name)
  RETURN name.length > 0 AND name.length <= 100 AND isSanitized(name)
END FUNCTION

FUNCTION getGreeting(language, name)
  translations = {
    'en': 'Hello, {name}!',
    'es': '¡Hola, {name}!',
    'fr': 'Bonjour, {name}!'
  }
  
  template = translations[language]
  RETURN template.replace('{name}', name)
END FUNCTION

FUNCTION formatAsJson(greeting, language, name)
  RETURN {
    greeting: greeting,
    language: language,
    recipient: name,
    timestamp: currentTimestamp()
  }
END FUNCTION

FUNCTION formatAsHtml(greeting)
  RETURN '<h1>' + escapeHtml(greeting) + '</h1>'
END FUNCTION
```

## Test Cases (TDD Anchors)

1. **Basic functionality**: helloWorld() returns "Hello, World!"
2. **Name parameter**: helloWorld({name: 'Alice'}) returns "Hello, Alice!"
3. **Language support**: helloWorld({language: 'es'}) returns "¡Hola, World!"
4. **Format options**: helloWorld({format: 'json'}) returns JSON object
5. **Error handling**: Invalid inputs throw appropriate errors
6. **Edge cases**: Empty strings, special characters, long names