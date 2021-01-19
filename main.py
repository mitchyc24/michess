import pygame
import random
from pygame_button import Button
from config import *
from game import Game

from win32api import GetSystemMetrics


def setup():
    global screen, game, clock, buttons
    pygame.init()
    pygame.mixer.init()
    clock = pygame.time.Clock()
    
    S_WIDTH = GetSystemMetrics(0)
    S_HEIGHT = GetSystemMetrics(1)  
    screen = pygame.display.set_mode((int(S_WIDTH*0.5),int(S_HEIGHT*0.5)))
    pygame.display.set_caption("michess")
    pygame.display.set_icon(ICON)

    game = Game()
    buttons = [Button((20, 30, 200, 50), LIGHT_GREY, new_game, text="New Game", **BUTTON_STYLE)]
    buttons.append(Button((20, 100, 200, 50), LIGHT_GREY, new_game, text="Undo", **BUTTON_STYLE))
    buttons.append(Button((20, 170, 200, 50), LIGHT_GREY, game.random_move, text="Random Move", **BUTTON_STYLE))

def main():
    running = True
    while running:
        running = handle_events()
        screen.fill(BLACK)
        draw_buttons(buttons)
        draw_game(screen, game)

        clock.tick(FPS)
        pygame.display.flip()

def new_game():
    global game
    print("New Game!")
    game = Game()

def draw_game(surface, game):
    draw_board(surface)
    draw_pieces(surface, game)

def draw_board(surface):
    for row in range(8):
        for col in range(8):
            if (row+col)%2 == 0: colour = WHITE_SQUARE
            else: colour = BLACK_SQUARE
            pygame.draw.rect(surface, colour, pygame.Rect((col*PIECE_SIZE+X_OFFSET,row*PIECE_SIZE+Y_OFFSET),(PIECE_SIZE,PIECE_SIZE)))
    
def draw_pieces(surface, game):
    squares = game.iter_squares()
    for square in squares:
        if square[1] != EMPTY:
            x = X_OFFSET + square[0][1]*PIECE_SIZE
            y = Y_OFFSET + square[0][0]*PIECE_SIZE
            surface.blit(PIECES[square[1]],(x,y))

    if (game.piece_in_hand):
        draw_held_piece(surface, game.piece_in_hand)
    else:
        pygame.mouse.set_visible(True)
   
def draw_held_piece(surface, piece):
    pygame.mouse.set_visible(False)
    mouseX, mouseY = pygame.mouse.get_pos()
    surface.blit(PIECES[piece],(mouseX-30,mouseY-30))

def pos_in_board(pos):
    if BOARD[0][0] <= pos[0] <= BOARD[1][0]:
        if BOARD[0][1] <= pos[1] <= BOARD[1][1]:
            return True
    return False

def draw_buttons(buttons):
    for button in buttons:
        button.update(screen)

def handle_events():
    for event in pygame.event.get():
            if event.type == pygame.QUIT:
                return False

            for button in buttons:
                button.check_event(event)

            if event.type == pygame.MOUSEBUTTONDOWN:
                if pos_in_board(event.pos):
                    if event.button == 1:
                        pos = event.pos
                        col = int((pos[0] - X_OFFSET)/PIECE_SIZE)
                        row = int((pos[1] - Y_OFFSET)/PIECE_SIZE)
                        game.handle_click((row,col))
                    else: 
                        print(f"Unimplemented Button click: {event}")
               
    return True

        

if __name__ == "__main__":
    setup()
    main()